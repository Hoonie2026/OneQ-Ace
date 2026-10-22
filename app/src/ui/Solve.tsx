import { useEffect, useRef, useState } from 'react';
import { db, type AttemptRow, type QuestionRow } from '../db';
import { deadlineOf, easyToUnknown, examLabel, finishRun, firstUnanswered, loadSession, pauseRun, recordAnswer, resumeRun, saveNote, type Session, type Target } from '../study';
import { ZoomImage } from './ZoomImage';
import { questionMeta, startRelearn, startSubject, startToday, todayStatus, type TodayStatus } from '../coach';
import { aiModeUrl, searchQuery } from '../search';
import { askChoice, askConfirm } from './Dialog';
import { Icon } from './Icon';
import { Calculator } from './Calculator';
import { Scratchpad } from './Scratchpad';

const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
const MAX_ELAPSED = 30 * 60 * 1000;

/**
 * 풀이 화면. 열 때마다 "안 푼 첫 문항"에서 시작한다(이어 풀기). 이전 문항으로 돌아가 채점 결과를 다시 볼 수 있다.
 * 위치는 저장하지 않는다 — 진행 상태는 원장(attempts)에서 계산하므로 앱을 닫아도 그대로다(ADR 003).
 *
 * 모의고사(5단계): 정답을 보여 주지 않고 고르면 다음 문항으로. 남은 시간이 위에 보이고, 제출하거나 시간이 끝나면 채점(성적 화면).
 * ✕로 나가면 남은 시간이 멈추고, 이어서 열면 그때부터 다시 흐른다(앱을 강제로 닫으면 계속 흐름).
 *
 * v0.7(실기기 v0.6.0 의견): 교재 없이 앱만으로 공부하므로 **웹검색**(문항 핵심 낱말로 구글 AI 모드).
 * v0.9.2(실사용 의견): 웹검색은 **답한 뒤 정답·오답 화면에서만** — 검색으로 맞힌 기록이 성적을 왜곡하지 못하게.
 * 그 자리에는 **[쉬움]**: 보기를 고르지 않고 정답 처리(FSRS Easy — 다음 복습이 길게). 정답을 보고 사실 몰랐으면 [모름으로 바꾸기].
 * "한 줄 설명"은 **메모**로 — 메모가 있는 문항은 다시 풀 때 "메모 있음"이 보인다(다른 회차의 같은 문항 메모 포함).
 */
export function Solve(props: { target: Target; /** 나가기 — 과목별 학습 묶음이면 'subjects'(과목별 학습 화면으로, v0.11.4) */ onExit: (view?: 'subjects') => void; onResult: (peek?: boolean) => void; onSolve?: (t: Target) => void }) {
  const [s, setS] = useState<Session | null>(null);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<QuestionRow | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [history, setHistory] = useState<Map<string, string[]>>(new Map());
  const [siblings, setSiblings] = useState<Map<string, string[]>>(new Map());
  /** 다른 회차의 같은 문항에 쓴 메모(이 문항 메모가 없을 때) */
  const [otherNote, setOtherNote] = useState('');
  /** 오늘 학습 진행(오늘 학습·과목 학습 묶음만). 목표를 넘는 답을 하면 다음 단추에서 "오늘 목표 달성" 상자(v0.7.1) */
  const [today, setToday] = useState<TodayStatus | null>(null);
  const [goalPending, setGoalPending] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [showRounds, setShowRounds] = useState(false);
  /**
   * 계산 도구(v0.10): 계산기·손글씨 메모. v0.10.4(사용자 결정): 계산 문제 자동 판정·자동 열기는 없앰 —
   * 모든 문항에서 보기 아래 줄 [계산기|메모]를 필요할 때 누른다. 열어 둔 도구는 다음 문항에서도 그대로(메모 내용만 문항마다 새 장)
   */
  const [tool, setTool] = useState<'calc' | 'memo' | null>(null);
  const shownAt = useRef(performance.now());
  const hiddenFor = useRef(0);
  const hiddenAt = useRef<number | null>(null);

  // 화면을 떠나 있던 시간은 풀이 시간에서 뺀다(앱 전환·화면 꺼짐)
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) hiddenAt.current = performance.now();
      else if (hiddenAt.current !== null) {
        hiddenFor.current += performance.now() - hiddenAt.current;
        hiddenAt.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    (async () => {
      const ss = await loadSession(props.target);
      if (!ss) return props.onExit();
      // 모의고사를 ✕로 멈췄다가 다시 열면 멈춘 시간만큼 마감을 미룬다(실기기 v0.3.0 Q6)
      if (ss.run.mode === 'mock' && !ss.run.finishedAt && ss.run.pausedAt != null) ss.run = await resumeRun(ss.run);
      const start = firstUnanswered(ss);
      if (start < 0 || (ss.target.kind === 'set' && ss.run.finishedAt)) return props.onResult(); // 다 풀었거나 제출한 묶음이면 성적으로
      setS(ss);
      if (ss.run.mode === 'today') todayStatus(ss.run.certCode ?? ss.pack.manifest.cert.code).then(setToday).catch(() => undefined);
      setIndex(start);
      // 출제 이력(같은 내용이 나온 회차) — 문항 오른쪽 위 "n회 출제"(ADR 008)
      questionMeta(ss.run.certCode ?? ss.pack.manifest.cert.code)
        .then((m) => {
          setHistory(m.history);
          setSiblings(m.siblings);
        })
        .catch(() => undefined);
    })();
  }, [JSON.stringify(props.target)]);

  const qid = s?.qids[index];
  const isMock = s?.run.mode === 'mock';
  const deadline = isMock && s ? deadlineOf(s.run) : null;

  // 모의고사 남은 시간. 끝나면 제출
  useEffect(() => {
    if (!deadline || !s) return;
    const tick = () => {
      const n = Date.now();
      setNowMs(n);
      if (n >= deadline) {
        window.clearInterval(id);
        finishRun(s.run.sessionId).then(() => props.onResult());
      }
    };
    const id = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(id);
  }, [deadline, s?.run.sessionId]);

  useEffect(() => {
    if (!qid) return;
    let url: string | null = null;
    let alive = true;
    (async () => {
      const [question, image, n] = await Promise.all([db.questions.get(qid), db.images.get([qid, 'full']), db.notes.get(qid)]);
      if (!alive) return;
      url = image ? URL.createObjectURL(image.data) : null;
      setLoaded(question ?? null);
      setImg(url);
      setNote(n?.text ?? '');
      setNoteOpen(false);
      setShowRounds(false);
      shownAt.current = performance.now();
      hiddenFor.current = 0;
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [qid]);

  // 이 문항 메모가 없으면 다른 회차의 같은 문항 메모를 찾는다
  useEffect(() => {
    let alive = true;
    const sib = qid ? siblings.get(qid) ?? [] : [];
    if (!qid || note || !sib.length) {
      setOtherNote('');
      return;
    }
    db.notes.bulkGet(sib).then((rows) => {
      if (alive) setOtherNote(rows.find((x) => x?.text)?.text ?? '');
    });
    return () => {
      alive = false;
    };
  }, [qid, siblings, note === '']);

  // 다음 문항을 읽는 동안에는 이전 문항을 쓰지 않는다(빠른 연속 탭이 이전 문항에 기록되던 경합 방지)
  const q = loaded && loaded.qid === qid ? loaded : null;
  const attempt: AttemptRow | undefined = q ? s?.answers.get(q.qid) : undefined;
  const pickTool = (t: 'calc' | 'memo') => setTool((cur) => (cur === t ? null : t));

  const answer = async (chosen: number, easy = false) => {
    if (!s || !q || attempt || saving) return;
    setSaving(true);
    try {
      const elapsed = Math.min(MAX_ELAPSED, performance.now() - shownAt.current - hiddenFor.current);
      const res = await recordAnswer(s, q, chosen, elapsed, { easy });
      setS(res.session);
      if (isMock) {
        // 모의고사: 정답을 알리지 않고 다음 안 푼 문항으로(다 풀었으면 채점)
        if (navigator.vibrate) navigator.vibrate(10);
        const ss = res.session;
        const after = ss.qids.findIndex((x, i) => i > index && !ss.answers.has(x));
        const any = firstUnanswered(ss);
        const to = after >= 0 ? after : any;
        if (to < 0) props.onResult();
        else setIndex(to);
        return;
      }
      if (navigator.vibrate) navigator.vibrate(res.attempt.correct ? 15 : [30, 40, 30]);
      if (today) {
        const a = res.attempt;
        const t = { ...today, done: today.done + 1, correct: today.correct + (a.correct ? 1 : 0), unknown: today.unknown + (a.chosen === 0 ? 1 : 0), wrong: today.wrong + (!a.correct && a.chosen !== 0 ? 1 : 0) };
        setToday(t);
        if (t.target > 0 && today.done < t.target && t.done >= t.target) setGoalPending(true);
      }
    } finally {
      setSaving(false);
    }
  };

  /** [쉬움]을 눌렀지만 정답을 보니 몰랐을 때 → 모름으로(오늘 진행 수도 고침) */
  const toUnknown = async () => {
    if (!s || !q || !attempt?.easy || saving) return;
    setSaving(true);
    try {
      setS(await easyToUnknown(s, q.qid));
      if (today) setToday({ ...today, correct: Math.max(0, today.correct - 1), unknown: today.unknown + 1 });
    } finally {
      setSaving(false);
    }
  };

  const flushNote = async () => {
    if (noteOpen && q) await saveNote(q, note);
    setNoteOpen(false);
  };

  const next = async () => {
    if (!s) return;
    await flushNote();
    if (goalPending) {
      // 방금 답으로 오늘 목표를 채웠다 → 결과를 보여 주고 계속할지 묻는다
      setGoalPending(false);
      setGoalOpen(true);
      return;
    }
    // 다음 안 푼 문항(뒤로 갔다 왔으면 원래 자리로). 남은 것이 없으면 성적
    const after = s.qids.findIndex((x, i) => i > index && !s.answers.has(x));
    const any = firstUnanswered(s);
    const target = after >= 0 ? after : any;
    if (target < 0) {
      // 오늘 학습 묶음을 다 풀었으면 틀린·모름 문항을 한 번 더 — 같은 흐름에서 바로(ADR 010)
      if (s.run.mode === 'today' && !s.run.relearn && props.onSolve) {
        const wrong = s.qids.filter((x) => s.answers.get(x) && !s.answers.get(x)!.correct);
        const t = wrong.length ? await startRelearn(s.run.certCode ?? s.pack.manifest.cert.code, wrong) : null;
        if (t) return props.onSolve(t);
      }
      return props.onResult();
    }
    setIndex(target);
  };

  const certCode = s ? s.run.certCode ?? s.pack.manifest.cert.code : '';
  /**
   * 오늘 목표 달성 → 계속.
   * - 시스템 추천 학습: 지금 묶음을 닫고 오늘 기록(오늘 틀린·모름 먼저 → 복습 → 새 문항)으로 다시 추천
   * - 과목별 학습: 그 과목을 고른 것이므로 남은 문항을 이어서, 다 풀었으면 그 과목에서 다시 추천
   */
  const continueToday = async () => {
    if (!s) return;
    setGoalOpen(false);
    const left = s.qids.some((x) => !s.answers.has(x));
    if (s.run.subjectKey && left) return next();
    await finishRun(s.run.sessionId);
    // 오늘 학습 묶음을 다 풀었으면 먼저 그 묶음의 틀린·모름 문항 "다시 풀기"(주황 띠로 구분), 없으면 새 추천
    const wrong = s.run.relearn || left ? [] : s.qids.filter((x) => s.answers.get(x) && !s.answers.get(x)!.correct);
    const t = s.run.subjectKey
      ? await startSubject(certCode, s.run.subjectKey)
      : wrong.length
        ? await startRelearn(certCode, wrong)
        : await startToday(certCode);
    if (t && props.onSolve) props.onSolve(t);
    else props.onExit(s.run.subjectKey ? 'subjects' : undefined);
  };
  /** 홈으로(v0.11 — "오늘 학습 마치기" 대신): 이 묶음을 닫고 홈으로. 푼 기록은 답할 때마다 이미 저장됨 */
  const goHome = async () => {
    if (!s) return;
    await finishRun(s.run.sessionId);
    setGoalOpen(false);
    props.onExit(s.run.subjectKey ? 'subjects' : undefined);
  };

  const prev = async () => {
    await flushNote();
    setIndex((i) => Math.max(0, i - 1));
  };

  /**
   * ✕ — v0.11(ADR 020, 실기기 의견): 시스템 추천·과목별·다시 풀기는 묻지 않고 홈으로. 답은 하나하나 이미 저장됐고,
   * 묶음은 닫는다 — 다음에 시작하면 오늘 남은 목표만큼 오늘 기록으로 다시 고른다(v0.8.3의 [오늘 학습 마치기|나중에 이어서 하기] 선택 창 삭제).
   * 모의고사만 실제 시험처럼 멈춤·이어 풀기·제출을 묻는다
   */
  const exit = async () => {
    await flushNote();
    // 모의고사(v0.9.0 — 실기기 의견: ✕를 누르면 아무 안내 없이 홈으로 갔다): 멈출지·제출할지 묻는다
    if (isMock && s && !s.run.finishedAt) {
      const left = s.qids.filter((x) => !s.answers.has(x)).length;
      const pick = await askChoice(`${s.qids.length}문항 중 ${left}문항이 남았습니다.\n멈추면 남은 시간도 멈추고, 모의고사 화면에서 이어서 풀 수 있습니다.`, [
        { value: 'pause', text: '멈추고 나중에 이어서 풀기', primary: true },
        { value: 'submit', text: '지금 제출하고 채점' },
      ], { title: '모의고사를 멈출까요?', cancelText: '계속 풀기' });
      if (pick === 'submit') {
        await finishRun(s.run.sessionId);
        return props.onResult();
      }
      if (pick !== 'pause') return;
      await pauseRun(s.run.sessionId);
      return props.onExit();
    }
    if (s && s.run.mode === 'today' && !s.run.finishedAt) return goHome();
    if (s?.run.subjectKey) return props.onExit('subjects');
    props.onExit();
  };

  /** 문항 핵심 낱말로 구글 검색 AI 모드(새 탭). v0.9.2부터 답한 뒤 정답·오답 화면에서만 */
  const webSearch = () => {
    if (!q || !s) return;
    const m = (s.packs.get(q.packId) ?? s.pack).manifest;
    const subjName = m.subjects.find((x) => x.no === q.subjectNo)?.name ?? '';
    window.open(aiModeUrl(searchQuery(q.text ?? '', subjName), m.cert.name), '_blank', 'noopener');
  };

  const submit = async () => {
    if (!s) return;
    const left = s.qids.filter((x) => !s.answers.has(x)).length;
    if (left && !(await askConfirm(`${left}문항을 아직 안 풀었습니다(안 푼 문항은 0점). 제출하고 채점할까요?`, { title: '모의고사 제출', okText: '제출', cancelText: '계속 풀기' }))) return;
    await finishRun(s.run.sessionId);
    props.onResult();
  };

  // PC 키보드(v0.10): 1~4 보기, M 모름, E 쉬움, Enter·→ 다음, ← 이전. 계산기·메모 입력 중이거나 창이 떠 있으면 무시
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey || goalOpen || document.querySelector('[data-testid="dialog"]')) return;
    if (el && (el.closest('input, textarea, select, [contenteditable="true"], .calc') !== null)) return;
    const k = e.key;
    if (!attempt && /^[1-5]$/.test(k) && Number(k) <= (q?.choiceCount ?? 4)) answer(Number(k));
    else if (!attempt && (k === 'm' || k === 'M' || k === 'ㅡ')) answer(0);
    else if (!attempt && !isMock && (k === 'e' || k === 'E' || k === 'ㄷ')) answer(0, true);
    else if (attempt && (k === 'Enter' || k === 'ArrowRight')) next();
    else if (k === 'ArrowLeft' && index > 0) prev();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (!s) return <div className="solve" />;
  const qPack = (q && s.packs.get(q.packId)) || s.pack;
  const subject = qPack.manifest.subjects.find((x) => x.no === q?.subjectNo);
  const answeredCount = s.qids.filter((x) => s.answers.has(x)).length;
  const remaining = s.qids.length - answeredCount;
  const chosenOk = attempt?.correct;

  return (
    <div className={`solve${s.run.relearn ? ' is-relearn' : ''}`}>
      <header className="solve-top">
        <button className="icon-btn" onClick={exit} aria-label="풀이 멈추고 홈으로">
          <Icon name="close" size={24} />
        </button>
        <button className="icon-btn" onClick={prev} disabled={index === 0} aria-label="이전 문항">
          <Icon name="back" size={24} />
        </button>
        {/* v0.11.4(실기기 의견): 가운데 진행 수, 오른쪽에 과목명(진하게)·회차 두 줄. [성적] 단추는 없앰(모의고사 [제출]은 남은 시간 줄로) */}
        <div className="solve-meta">
          <strong data-testid="progress">
            {index + 1} / {s.qids.length}
          </strong>
        </div>
        <div className="solve-src" data-testid="solve-src">
          {subject && <b className="solve-subj">{subject.name}</b>}
          <small>{examLabel(qPack.manifest)}</small>
        </div>
      </header>
      <div className="solve-progress" aria-hidden="true">
        <div style={{ width: `${(answeredCount / s.qids.length) * 100}%` }} />
      </div>
      {s.run.relearn && (
        // v0.7.2(실기기 의견): 새 문항이 아니라 오늘 틀린·모름 문항을 다시 푸는 단계임을 한눈에
        <div className="relearn-banner" role="status" data-testid="relearn-banner">
          <span className="relearn-icon" aria-hidden="true">
            <Icon name="repeat" size={26} />
          </span>
          <div>
            <b>
              다시 풀기 · {index + 1} / {s.qids.length}
            </b>
            <span>방금 푼 묶음에서 틀리거나 모른 {s.qids.length}문항을 한 번 더 풉니다. 새 문항이 아닙니다.</span>
          </div>
        </div>
      )}
      {isMock && (
        <div className="mock-bar">
          <p className={`mock-timer${deadline && deadline - nowMs < 5 * 60_000 ? ' bad' : ''}`} role="timer" data-testid="mock-timer">
            남은 시간 <b>{fmtLeft(deadline ? deadline - nowMs : 0)}</b>
          </p>
          <button className="score-btn" onClick={submit} aria-label="제출하고 채점" data-testid="mock-submit">
            제출
          </button>
        </div>
      )}
      {q && ((history.get(q.qid)?.length ?? 0) > 1 || (!isMock && (note || otherNote))) && (
        <div className="freq-row">
          {(history.get(q.qid)?.length ?? 0) > 1 && (
            <button className="freq-badge" onClick={() => setShowRounds((v) => !v)} aria-expanded={showRounds} data-testid="freq-badge">
              <Icon name="flame" size={14} />
              {history.get(q.qid)!.length}회 출제
            </button>
          )}
          {!isMock && (note || otherNote) && (
            <span className="memo-badge" data-testid="memo-badge">
              <Icon name="note" size={15} /> 메모 있음
            </span>
          )}
          {showRounds && <span className="freq-list">{history.get(q.qid)!.join(' · ')}</span>}
        </div>
      )}

      <div className="solve-body">
        {q ? <ZoomImage key={q.qid} src={img} width={q.imgSize[0]} height={q.imgSize[1]} alt={`${q.no}번 문항`} /> : <div className="zoom" />}
        <div className="solve-side">
          {attempt && q && !isMock && (
            <section className={`feedback ${chosenOk ? 'is-ok' : 'is-bad'}`} aria-live="polite" data-testid="feedback">
              <p className="feedback-line">
                <b>{attempt.easy ? '✓ 쉬움' : chosenOk ? '✓ 정답' : attempt.chosen === 0 ? '? 모름' : '✕ 오답'}</b>
                <span>
                  정답 {CIRCLED[q.answer]}
                  {(q.acceptAlso ?? []).map((x) => `·${CIRCLED[x]}`).join('')}
                  {attempt.chosen !== 0 && !chosenOk && ` · 내 답 ${CIRCLED[attempt.chosen]}`}
                </span>
              </p>
              {!noteOpen && (note || otherNote) && (
                <div className="memo-box" data-testid="memo-box">
                  <span className="memo-label">{note ? '내 메모' : '다른 회차 같은 문항 메모'}</span>
                  <p>{note || otherNote}</p>
                </div>
              )}
              <div className="feedback-tools">
                <button className={`chip-btn memo-btn${note ? ' on' : ''}`} onClick={() => {
                  if (!note && otherNote) setNote(otherNote);
                  setNoteOpen((v) => !v);
                }} aria-expanded={noteOpen} data-testid="memo-btn">
                  <Icon name="pencil" size={17} /> {note ? '메모 수정' : '메모 쓰기'}
                </button>
                <button className="chip-btn" onClick={webSearch} data-testid="search-after">
                  <Icon name="search-ai" size={17} /> 웹검색
                </button>
                {attempt.easy && (
                  <button className="chip-btn" onClick={toUnknown} data-testid="easy-undo">
                    모름으로 바꾸기
                  </button>
                )}
              </div>
              {noteOpen && (
                <textarea
                  className="note"
                  rows={3}
                  maxLength={500}
                  value={note}
                  autoFocus
                  placeholder="이 문제의 개념·풀이 요령을 메모해 두세요. 다시 풀 때 '메모 있음'으로 보입니다"
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={() => saveNote(q, note)}
                />
              )}
            </section>
          )}

          {/* v0.10.1(실기기 Y5): 계산기 ↔ 메모를 오가도, 닫았다 열어도 같은 문항에서는 그대로 — 둘 다 그려 두고 보이기만 바꾼다.
              메모는 문항이 바뀌면 새 장(key), 계산기 식·기록은 계속 */}
          <div className={`tool-panel is-${tool ?? 'none'}`} hidden={!tool} data-testid="tool-panel">
            <div hidden={tool !== 'calc'}>
              <Calculator />
            </div>
            <div className="tool-memo" hidden={tool !== 'memo'}>
              <Scratchpad key={qid} />
            </div>
          </div>
          <footer className="solve-bottom">
            <div className="choices" role="group" aria-label="보기 선택">
              {Array.from({ length: q?.choiceCount ?? 4 }, (_, i) => i + 1).map((n) => {
                const state = !attempt
                  ? ''
                  : isMock
                    ? n === attempt.chosen
                      ? ' is-picked'
                      : ' is-dim'
                    : n === q?.answer || q?.acceptAlso?.includes(n)
                    ? ' is-answer'
                    : n === attempt.chosen
                      ? ' is-chosen'
                      : ' is-dim';
                return (
                  <button key={n} className={`choice${state}`} disabled={!!attempt || saving || !q} onClick={() => answer(n)} aria-label={`${n}번`}>
                    {n}
                  </button>
                );
              })}
            </div>
            {/* v0.10.5(사용자 의견): 하단 2줄 — 보기 아래 한 줄에 [모름|쉬움](답한 뒤 [다음 →]) 박스와 [계산기|메모] 박스. 답한 뒤 도구는 아이콘만 */}
            <div className={`act-row${attempt ? ' is-answered' : ''}`}>
              {attempt ? (
                <button className="btn btn-primary btn-next" onClick={next}>
                  {remaining === 0 ? (isMock ? '채점하기' : '성적 보기') : '다음 →'}
                </button>
              ) : (
                <div className="act-group act-answer">
                  <button className="btn btn-next btn-unknown" disabled={saving || !q} onClick={() => answer(0)}>
                    모름
                  </button>
                  {!isMock && (
                    <button className="btn btn-next btn-easy" disabled={saving || !q} onClick={() => answer(0, true)} data-testid="easy">
                      쉬움
                    </button>
                  )}
                </div>
              )}
              <div className="act-group act-tools tool-bar" role="toolbar" aria-label="계산 도구">
                <button type="button" className={`tool-btn${tool === 'calc' ? ' on' : ''}`} onClick={() => pickTool('calc')} aria-pressed={tool === 'calc'} aria-label="계산기" data-testid="tool-calc">
                  <Icon name="calculator" size={18} />
                  <span>계산기</span>
                </button>
                <button type="button" className={`tool-btn${tool === 'memo' ? ' on' : ''}`} onClick={() => pickTool('memo')} aria-pressed={tool === 'memo'} aria-label="메모" data-testid="tool-memo">
                  <Icon name="memo" size={18} />
                  <span>메모</span>
                </button>
              </div>
            </div>
          </footer>
        </div>
      </div>

      {goalOpen && today && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="goal-title" data-testid="goal-box">
          <section className="modal">
            <h2 id="goal-title">
              <Icon name="trophy" size={24} /> 오늘 학습 목표 달성
            </h2>
            <p className="muted">
              오늘 목표 {today.target}문항을 다 풀었습니다.
            </p>
            <ul className="goal-stats">
              <li>
                <small>푼 문항</small>
                <b>{today.done}</b>
              </li>
              <li className="ok">
                <small>정답</small>
                <b>{today.correct}</b>
              </li>
              <li className="bad">
                <small>오답</small>
                <b>{today.wrong}</b>
              </li>
              <li className="unk">
                <small>모름</small>
                <b>{today.unknown}</b>
              </li>
            </ul>
            <p className="goal-score">
              오늘 성적 <b data-testid="goal-score">{today.done ? Math.round((today.correct / today.done) * 100) : 0}</b>점 <small className="muted">(정답 ÷ 푼 문항)</small>
            </p>
            <div className="stack">
              <button className="btn btn-primary btn-block btn-big" onClick={continueToday} data-testid="goal-continue">
                {!s.run.subjectKey && !s.run.relearn && s.qids.some((x) => s.answers.get(x) && !s.answers.get(x)!.correct)
                  ? `오답/모름 ${s.qids.filter((x) => s.answers.get(x) && !s.answers.get(x)!.correct).length}문항 다시 풀기`
                  : '계속 학습하기 (오늘 기록으로 추천)'}
              </button>
              <button className="btn btn-block" onClick={goHome} data-testid="goal-end">
                {s.run.subjectKey ? '다른 과목 고르기' : '홈으로'}
              </button>
            </div>
          </section>
        </div>
      )}

    </div>
  );
}

/** 남은 시간 1:23:45 / 12:05 */
function fmtLeft(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
