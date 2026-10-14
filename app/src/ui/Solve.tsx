import { useCallback, useEffect, useRef, useState } from 'react';
import { db, type AttemptRow, type PackRow, type QuestionRow, type RunRow } from '../db';
import { examLabel, finishRun, moveRun, recordAnswer, saveNote, setUnsure } from '../study';
import { ZoomImage } from './ZoomImage';

const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
const MAX_ELAPSED = 30 * 60 * 1000;

export function Solve(props: { sessionId: string; onExit: () => void; onFinish: (sessionId: string) => void }) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [pack, setPack] = useState<PackRow | null>(null);
  const [q, setQ] = useState<QuestionRow | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<AttemptRow | null>(null);
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
      const r = await db.runs.get(props.sessionId);
      if (!r) return props.onExit();
      setRun(r);
      setPack((await db.packs.get(r.packId)) ?? null);
    })();
  }, [props.sessionId]);

  const qid = run?.qids[run.index];

  useEffect(() => {
    if (!run || !qid) return;
    let url: string | null = null;
    let alive = true;
    (async () => {
      const [question, image, n] = await Promise.all([
        db.questions.get(qid),
        db.images.get([qid, 'full']),
        db.notes.get(qid),
      ]);
      const uid = run.answered[qid];
      const a = uid ? await db.attempts.where('uid').equals(uid).first() : undefined;
      if (!alive) return;
      url = image ? URL.createObjectURL(image.data) : null;
      setQ(question ?? null);
      setImg(url);
      setAttempt(a ?? null);
      setNote(n?.text ?? '');
      setNoteOpen(false);
      shownAt.current = performance.now();
      hiddenFor.current = 0;
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
    // run.answered가 바뀌어도(채점 직후) 문항을 다시 읽지 않는다
  }, [qid, run?.sessionId]);

  const answer = async (chosen: number) => {
    if (!run || !q || attempt || saving) return;
    setSaving(true);
    try {
      const elapsed = Math.min(MAX_ELAPSED, performance.now() - shownAt.current - hiddenFor.current);
      const res = await recordAnswer(run, q, chosen, elapsed);
      setRun(res.run);
      setAttempt(res.attempt);
      if (navigator.vibrate) navigator.vibrate(res.attempt.correct ? 15 : [30, 40, 30]);
    } finally {
      setSaving(false);
    }
  };

  const go = useCallback(
    async (delta: number) => {
      if (!run) return;
      if (noteOpen && q) await saveNote(q, note);
      const target = run.index + delta;
      if (target >= run.qids.length) {
        const done = await finishRun(run);
        props.onFinish(done.sessionId);
        return;
      }
      if (target < 0) return;
      setRun(await moveRun(run, target));
    },
    [run, noteOpen, q, note, props],
  );

  const toggleUnsure = async () => {
    if (!attempt) return;
    await setUnsure(attempt.uid, !attempt.unsure);
    setAttempt({ ...attempt, unsure: !attempt.unsure });
  };

  if (!run || !pack) return <div className="solve" />;
  const subject = pack.manifest.subjects.find((s) => s.no === q?.subjectNo);
  const answeredCount = Object.keys(run.answered).length;
  const isLast = run.index === run.qids.length - 1;
  const chosenOk = attempt?.correct;

  return (
    <div className="solve">
      <header className="solve-top">
        <button className="icon-btn" onClick={props.onExit} aria-label="풀이 멈추고 홈으로">
          ✕
        </button>
        <div className="solve-meta">
          <strong data-testid="progress">
            {run.index + 1} / {run.qids.length}
          </strong>
          <span>
            {examLabel(pack.manifest)} · {q ? `${q.no}번` : ''} · {subject ? `${subject.no}과목 ${subject.name}` : ''}
          </span>
        </div>
        <button className="icon-btn" onClick={() => go(-1)} disabled={run.index === 0} aria-label="이전 문항">
          ‹
        </button>
      </header>
      <div className="solve-progress" aria-hidden="true">
        <div style={{ width: `${(answeredCount / run.qids.length) * 100}%` }} />
      </div>

      {q ? (
        <ZoomImage key={q.qid} src={img} width={q.imgSize[0]} height={q.imgSize[1]} alt={`${q.no}번 문항`} />
      ) : (
        <div className="zoom" />
      )}

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
          <button className="btn btn-primary btn-block btn-next" onClick={() => go(1)}>
            {isLast ? '결과 보기' : '다음 →'}
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
