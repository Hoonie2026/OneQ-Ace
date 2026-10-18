import { useEffect, useRef, useState } from 'react';
import { db, type AttemptRow, type QuestionRow } from '../db';
import { examLabel, finishRun, firstUnanswered, loadSession, recordAnswer, saveNote, setUnsure, type Session, type Target } from '../study';
import { ZoomImage } from './ZoomImage';
import { questionHistory } from '../coach';

const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
const MAX_ELAPSED = 30 * 60 * 1000;

/**
 * 풀이 화면. 열 때마다 "안 푼 첫 문항"에서 시작한다(이어 풀기). 이전 문항으로 돌아가 채점 결과를 다시 볼 수 있다.
 * 위치는 저장하지 않는다 — 진행 상태는 원장(attempts)에서 계산하므로 앱을 닫아도 그대로다(ADR 003).
 *
 * 모의고사(5단계): 정답을 보여 주지 않고 고르면 다음 문항으로. 남은 시간이 위에 보이고, 제출하거나 시간이 끝나면 채점(성적 화면).
 * 시간은 시작 시각부터 흐른다(앱을 닫아도) — 실제 시험처럼.
 */
export function Solve(props: { target: Target; onExit: () => void; onResult: () => void }) {
  const [s, setS] = useState<Session | null>(null);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<QuestionRow | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [history, setHistory] = useState<Map<string, string[]>>(new Map());
  const [showRounds, setShowRounds] = useState(false);
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
      const start = firstUnanswered(ss);
      if (start < 0 || (ss.target.kind === 'set' && ss.run.finishedAt)) return props.onResult(); // 다 풀었거나 제출한 묶음이면 성적으로
      setS(ss);
      setIndex(start);
      // 출제 이력(같은 내용이 나온 회차) — 문항 오른쪽 위 "n회 출제"(ADR 008)
      questionHistory(ss.run.certCode ?? ss.pack.manifest.cert.code).then(setHistory).catch(() => undefined);
    })();
  }, [JSON.stringify(props.target)]);

  const qid = s?.qids[index];
  const isMock = s?.run.mode === 'mock';
  const deadline = isMock && s?.run.limitSec ? s.run.startedAt + s.run.limitSec * 1000 : null;

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

  // 다음 문항을 읽는 동안에는 이전 문항을 쓰지 않는다(빠른 연속 탭이 이전 문항에 기록되던 경합 방지)
  const q = loaded && loaded.qid === qid ? loaded : null;
  const attempt: AttemptRow | undefined = q ? s?.answers.get(q.qid) : undefined;

  const answer = async (chosen: number) => {
    if (!s || !q || attempt || saving) return;
    setSaving(true);
    try {
      const elapsed = Math.min(MAX_ELAPSED, performance.now() - shownAt.current - hiddenFor.current);
      const res = await recordAnswer(s, q, chosen, elapsed);
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
    // 다음 안 푼 문항(뒤로 갔다 왔으면 원래 자리로). 남은 것이 없으면 성적
    const after = s.qids.findIndex((x, i) => i > index && !s.answers.has(x));
    const any = firstUnanswered(s);
    const target = after >= 0 ? after : any;
    if (target < 0) return props.onResult();
    setIndex(target);
  };

  const prev = async () => {
    await flushNote();
    setIndex((i) => Math.max(0, i - 1));
  };

  const exit = async () => {
    await flushNote();
    props.onExit();
  };

  const toggleUnsure = async () => {
    if (!s || !attempt) return;
    await setUnsure(attempt.uid, !attempt.unsure);
    setS({ ...s, answers: new Map(s.answers).set(attempt.qid, { ...attempt, unsure: !attempt.unsure }) });
  };

  const submit = async () => {
    if (!s) return;
    const left = s.qids.filter((x) => !s.answers.has(x)).length;
    if (left && !window.confirm(`${left}문항을 아직 안 풀었습니다(0점 처리). 제출하고 채점할까요?`)) return;
    await finishRun(s.run.sessionId);
    props.onResult();
  };

  if (!s) return <div className="solve" />;
  const qPack = (q && s.packs.get(q.packId)) || s.pack;
  const subject = qPack.manifest.subjects.find((x) => x.no === q?.subjectNo);
  const answeredCount = s.qids.filter((x) => s.answers.has(x)).length;
  const remaining = s.qids.length - answeredCount;
  const chosenOk = attempt?.correct;

  return (
    <div className="solve">
      <header className="solve-top">
        <button className="icon-btn" onClick={exit} aria-label="풀이 멈추고 홈으로">
          ✕
        </button>
        <button className="icon-btn" onClick={prev} disabled={index === 0} aria-label="이전 문항">
          ‹
        </button>
        <div className="solve-meta">
          <strong data-testid="progress">
            {index + 1} / {s.qids.length}
          </strong>
          <span>
            {examLabel(qPack.manifest)} · {q ? `${q.no}번` : ''} · {subject ? (s.target.kind === 'set' ? subject.name : `${subject.no}과목 ${subject.name}`) : ''}
          </span>
        </div>
        {isMock ? (
          <button className="score-btn" onClick={submit} aria-label="제출하고 채점" data-testid="mock-submit">
            제출
          </button>
        ) : (
          <button
            className="score-btn"
            onClick={async () => {
              await flushNote();
              props.onResult();
            }}
            aria-label="지금 성적 보기"
          >
            📊 성적
          </button>
        )}
      </header>
      <div className="solve-progress" aria-hidden="true">
        <div style={{ width: `${(answeredCount / s.qids.length) * 100}%` }} />
      </div>
      {isMock && (
        <p className={`mock-timer${deadline && deadline - nowMs < 5 * 60_000 ? ' bad' : ''}`} role="timer" data-testid="mock-timer">
          남은 시간 <b>{fmtLeft(deadline ? deadline - nowMs : 0)}</b>
        </p>
      )}
      {q && (history.get(q.qid)?.length ?? 0) > 1 && (
        <div className="freq-row">
          <button className="freq-badge" onClick={() => setShowRounds((v) => !v)} aria-expanded={showRounds} data-testid="freq-badge">
            {history.get(q.qid)!.length}회 출제
          </button>
          {showRounds && <span className="freq-list">{history.get(q.qid)!.join(' · ')}</span>}
        </div>
      )}

      {q ? <ZoomImage key={q.qid} src={img} width={q.imgSize[0]} height={q.imgSize[1]} alt={`${q.no}번 문항`} /> : <div className="zoom" />}

      {attempt && q && !isMock && (
        <section className={`feedback ${chosenOk ? 'is-ok' : 'is-bad'}`} aria-live="polite" data-testid="feedback">
          <p className="feedback-line">
            <b>{chosenOk ? '✓ 정답' : attempt.chosen === 0 ? '? 모름' : '✕ 오답'}</b>
            <span>
              정답 {CIRCLED[q.answer]}
              {(q.acceptAlso ?? []).map((x) => `·${CIRCLED[x]}`).join('')}
              {attempt.chosen !== 0 && !chosenOk && ` · 내 답 ${CIRCLED[attempt.chosen]}`}
            </span>
          </p>
          <div className="feedback-tools">
            <button className={`chip-btn${attempt.unsure ? ' on' : ''}`} onClick={toggleUnsure} aria-pressed={attempt.unsure}>
              {attempt.unsure ? '☑' : '☐'} 헷갈림
            </button>
            <button className={`chip-btn${note ? ' on' : ''}`} onClick={() => setNoteOpen((v) => !v)} aria-expanded={noteOpen}>
              ✎ {note ? '내 설명' : '한 줄 설명'}
            </button>
          </div>
          {noteOpen && (
            <textarea
              className="note"
              rows={2}
              maxLength={300}
              value={note}
              placeholder="이 문제를 내 말로 한 줄 설명해 보세요"
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => saveNote(q, note)}
            />
          )}
        </section>
      )}

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
                {CIRCLED[n]}
              </button>
            );
          })}
        </div>
        {attempt ? (
          <button className="btn btn-primary btn-block btn-next" onClick={next}>
            {remaining === 0 ? (isMock ? '채점하기' : '성적 보기') : '다음 →'}
          </button>
        ) : (
          <button className="btn btn-block btn-next btn-unknown" disabled={saving || !q} onClick={() => answer(0)}>
            모름
          </button>
        )}
      </footer>
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
