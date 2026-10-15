import { useEffect, useState } from 'react';
import { ensureWrongRun, loadSession, restartPass, sessionResult, type Result as R, type Target } from '../study';

const VERDICT: Record<NonNullable<R['verdict']>, { icon: string; text: string; cls: string }> = {
  pass: { icon: '✓', text: '합격선 통과', cls: 'ok' },
  'fail-subject': { icon: '✕', text: '과락 과목 있음', cls: 'bad' },
  'fail-average': { icon: '!', text: '평균 60점 미만', cls: 'warn' },
};

/** 성적. 풀이 중에도 지금까지 푼 문항으로 실시간 계산한다(ADR 003) */
export function Result(props: { target: Target; onHome: () => void; onSolve: (t: Target) => void; toast: (m: string) => void }) {
  const [res, setRes] = useState<R | null>(null);
  const [rule, setRule] = useState({ min: 40, avg: 60 });
  const [packId, setPackId] = useState('');

  useEffect(() => {
    (async () => {
      const s = await loadSession(props.target);
      if (!s) return props.onHome();
      setPackId(s.pack.packId);
      setRule({ min: s.pack.manifest.passRule.subjectMin, avg: s.pack.manifest.passRule.avgMin });
      setRes(await sessionResult(s));
    })();
  }, [JSON.stringify(props.target)]);

  if (!res) return <div className="app" />;
  const v = res.verdict ? VERDICT[res.verdict] : null;
  const wholePass = props.target.kind === 'pass' && !props.target.subjectNo;

  const retryWrong = async () => {
    const run = await ensureWrongRun(packId);
    if (run) props.onSolve({ kind: 'wrong', sessionId: run.sessionId });
  };
  const newPass = async () => {
    if (!window.confirm('이 회차를 처음부터 다시 풉니다(새 회독). 지금까지의 풀이 기록은 그대로 남습니다. 시작할까요?')) return;
    await restartPass(packId);
    props.onSolve({ kind: 'pass', packId });
  };

  return (
    <div className="app">
      <header className="page-head">
        <button className="icon-btn" onClick={props.onHome} aria-label="뒤로">
          ‹
        </button>
        <h1>{res.complete ? '풀이 결과' : '지금까지 성적'}</h1>
      </header>
      <section className="card result-hero" data-testid="result">
        <p className="muted">
          {res.title} · {res.answered}/{res.total}문항 풀이
        </p>
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
        {!v && !res.complete && props.target.kind === 'pass' && !props.target.subjectNo && (
          <p className="hint">과목마다 5문항 이상 풀면 합격선 판정을 보여 줍니다.</p>
        )}
        {v && (
          <p className={`verdict ${v.cls}`}>
            <span aria-hidden="true">{v.icon}</span> {v.text}
            {res.complete ? '' : ' (지금까지 푼 문항 기준)'}
          </p>
        )}
      </section>

      <section className="card">
        <h2>과목별 {res.complete ? '점수' : '정답률'}</h2>
        <ul className="bars">
          {res.subjects.map((s) => {
            const val = res.complete ? s.score : s.rate;
            const risk = val !== null && val < rule.min;
            return (
              <li key={s.no}>
                <div className="bar-label">
                  <span>
                    {s.no}. {s.name}
                  </span>
                  <b className={risk ? 'bad' : ''}>{val === null ? '안 풂' : `${risk ? '과락 ' : ''}${val}${res.complete ? '점' : '%'}`}</b>
                </div>
                <div className="bar" role="img" aria-label={`${s.name} ${val ?? 0}`}>
                  <div className={`bar-fill${risk ? ' bad' : (val ?? 0) < rule.avg ? ' warn' : ''}`} style={{ width: `${val ?? 0}%` }} />
                  <i className="bar-line" style={{ left: `${rule.min}%` }} />
                  <i className="bar-line avg" style={{ left: `${rule.avg}%` }} />
                </div>
                <small className="muted">
                  맞힘 {s.correct} / 푼 문항 {s.answered} / 전체 {s.total}
                  {s.unknown ? ` · 모름 ${s.unknown}` : ''}
                </small>
              </li>
            );
          })}
        </ul>
        <p className="hint">
          세로선: 과락선 {rule.min} · 평균선 {rule.avg}.{' '}
          {res.complete ? '점수 = 맞힌 문항 ÷ 과목 전체 문항.' : '다 풀기 전에는 푼 문항의 정답률로 보여 줍니다.'}
        </p>
      </section>

      <section className="actions">
        {!res.complete && (
          <button className="btn btn-primary btn-block" onClick={() => props.onSolve(props.target)}>
            이어서 풀기 ({res.total - res.answered}문항 남음)
          </button>
        )}
        {res.wrongQids.length > 0 && (
          <button className={`btn btn-block${res.complete ? ' btn-primary' : ''}`} onClick={retryWrong}>
            틀린·모름 문항 다시 풀기
          </button>
        )}
        {res.complete && wholePass && (
          <button className="btn btn-block" onClick={newPass}>
            처음부터 다시 풀기(새 회독)
          </button>
        )}
        <button className="btn btn-block" onClick={props.onHome}>
          홈으로
        </button>
      </section>
    </div>
  );
}
