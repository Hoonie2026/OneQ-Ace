import { useEffect, useState } from 'react';
import { db, type PackRow, type RunRow } from '../db';
import { runResult, startRun, type RunResult } from '../study';

const VERDICT: Record<NonNullable<RunResult['verdict']>, { icon: string; text: string; cls: string }> = {
  pass: { icon: '✓', text: '합격선 통과', cls: 'ok' },
  'fail-subject': { icon: '✕', text: '과락 과목 있음', cls: 'bad' },
  'fail-average': { icon: '!', text: '평균 60점 미만', cls: 'warn' },
};

export function Result(props: { sessionId: string; onHome: () => void; onStart: (sessionId: string) => void }) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [pack, setPack] = useState<PackRow | null>(null);
  const [res, setRes] = useState<RunResult | null>(null);

  useEffect(() => {
    (async () => {
      const r = await db.runs.get(props.sessionId);
      if (!r) return props.onHome();
      setRun(r);
      setPack((await db.packs.get(r.packId)) ?? null);
      setRes(await runResult(r));
    })();
  }, [props.sessionId]);

  if (!run || !res) return <div className="app" />;
  const v = res.verdict ? VERDICT[res.verdict] : null;
  const min = pack?.manifest.passRule.subjectMin ?? 40;
  const avg = pack?.manifest.passRule.avgMin ?? 60;

  const retry = async () => {
    const next = await startRun(run.packId, 'wrong');
    if (next) props.onStart(next.sessionId);
  };

  return (
    <div className="app">
      <header className="page-head">
        <button className="icon-btn" onClick={props.onHome} aria-label="뒤로">
          ‹
        </button>
        <h1>풀이 결과</h1>
      </header>
      <section className="card result-hero" data-testid="result">
        <p className="muted">{run.title}</p>
        <div className="result-counts">
          <div className="rc ok">
            <b>{res.correct}</b>
            <span>맞힘</span>
          </div>
          <div className="rc bad">
            <b>{res.wrong}</b>
            <span>틀림</span>
          </div>
          <div className="rc unk">
            <b>{res.unknown}</b>
            <span>모름</span>
          </div>
        </div>
        {res.answered < res.total && <p className="hint">{res.total - res.answered}문항은 풀지 않았습니다.</p>}
        {v && (
          <p className={`verdict ${v.cls}`}>
            <span aria-hidden="true">{v.icon}</span> {v.text} · 평균 {res.average}점
          </p>
        )}
      </section>

      <section className="card">
        <h2>과목별 점수</h2>
        <ul className="bars">
          {res.subjects.map((s) => {
            const risk = s.score < min;
            return (
              <li key={s.no}>
                <div className="bar-label">
                  <span>
                    {s.no}. {s.name}
                  </span>
                  <b className={risk ? 'bad' : ''}>
                    {risk && '과락 '}
                    {s.score}점
                  </b>
                </div>
                <div className="bar" role="img" aria-label={`${s.name} ${s.score}점`}>
                  <div className={`bar-fill${risk ? ' bad' : s.score < avg ? ' warn' : ''}`} style={{ width: `${s.score}%` }} />
                  <i className="bar-line" style={{ left: `${min}%` }} title={`과락선 ${min}`} />
                  <i className="bar-line avg" style={{ left: `${avg}%` }} title={`평균선 ${avg}`} />
                </div>
                <small className="muted">
                  {s.correct}/{s.total} 정답{s.unknown ? ` · 모름 ${s.unknown}` : ''}
                </small>
              </li>
            );
          })}
        </ul>
        <p className="hint">세로선: 과락선 {min}점 · 평균선 {avg}점</p>
      </section>

      <section className="actions">
        {res.wrongQids.length > 0 && (
          <button className="btn btn-primary btn-block" onClick={retry}>
            틀린·모름 {res.wrongQids.length}문항 다시 풀기
          </button>
        )}
        <button className="btn btn-block" onClick={props.onHome}>
          홈으로
        </button>
      </section>
    </div>
  );
}
