import { useEffect, useRef, useState } from 'react';
import { db, type AttemptRow, type QuestionRow } from '../db';
import { examLabel, firstUnanswered, loadSession, recordAnswer, saveNote, setUnsure, type Session, type Target } from '../study';
import { ZoomImage } from './ZoomImage';

const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
const MAX_ELAPSED = 30 * 60 * 1000;

/**
 * 풀이 화면. 열 때마다 "안 푼 첫 문항"에서 시작한다(이어 풀기). 이전 문항으로 돌아가 채점 결과를 다시 볼 수 있다.
 * 위치는 저장하지 않는다 — 진행 상태는 원장(attempts)에서 계산하므로 앱을 닫아도 그대로다(ADR 003).
 */
export function Solve(props: { target: Target; onExit: () => void; onResult: () => void }) {
  const [s, setS] = useState<Session | null>(null);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<QuestionRow | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
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
      if (start < 0) return props.onResult(); // 다 풀었으면 성적으로
      setS(ss);
      setIndex(start);
    })();
  }, [JSON.stringify(props.target)]);

  const qid = s?.qids[index];

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

  if (!s) return <div className="solve" />;
  const subject = s.pack.manifest.subjects.find((x) => x.no === q?.subjectNo);
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
            {examLabel(s.pack.manifest)} · {q ? `${q.no}번` : ''} · {subject ? `${subject.no}과목 ${subject.name}` : ''}
          </span>
        </div>
        <button
          className="icon-btn score-btn"
          onClick={async () => {
            await flushNote();
            props.onResult();
          }}
          aria-label="지금 성적 보기"
        >
          <small>성적</small>
          <b data-testid="answered">{answeredCount}</b>
        </button>
      </header>
      <div className="solve-progress" aria-hidden="true">
        <div style={{ width: `${(answeredCount / s.qids.length) * 100}%` }} />
      </div>

      {q ? <ZoomImage key={q.qid} src={img} width={q.imgSize[0]} height={q.imgSize[1]} alt={`${q.no}번 문항`} /> : <div className="zoom" />}

      {attempt && q && (
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
            {remaining === 0 ? '성적 보기' : '다음 →'}
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
