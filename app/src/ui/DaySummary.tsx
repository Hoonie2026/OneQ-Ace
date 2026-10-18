import { useEffect, useState } from 'react';
import { daySummary, type DaySummary as S } from '../coach';

/**
 * 오늘 학습 마치기(ADR 009 — 실기기 v0.3.0 Q5): 오늘 푼 것, 현재 점수 ☞ 계획 이행 시 예상 점수, 학습 계획을 고칠지 묻는다.
 * 합격 가능성 카드 대신 이 한 화면에서 간단히 알린다.
 */
export function DaySummary(props: { certCode: string; onHome: () => void; onPlan: () => void }) {
  const [s, setS] = useState<S | null>(null);
  useEffect(() => {
    daySummary(props.certCode).then((x) => (x ? setS(x) : props.onHome()));
  }, [props.certCode]);
  if (!s) return <div className="app" />;
  const rate = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
  return (
    <div className="app">
      <header className="page-head">
        <button className="icon-btn" onClick={props.onHome} aria-label="뒤로">
          ‹
        </button>
        <h1>오늘 학습 마침</h1>
      </header>

      <section className="card result-hero" data-testid="day-summary">
        <p className="muted">
          오늘 {s.answered}문항 · 정답 {s.correct}({rate}%){s.unknown ? ` · 모름 ${s.unknown}` : ''}
        </p>
        <ul className="day-subjects">
          {s.bySubject.map((b) => (
            <li key={b.name}>
              <span>{b.name}</span>
              <b>
                {b.correct}/{b.answered}
              </b>
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack">
        <div className="score-pair">
          <div>
            <small>현재</small>
            <b>{s.currentAvg}</b>
            <small>점</small>
          </div>
          <span className="arrow" aria-hidden="true">
            ☞
          </span>
          <div className={s.short ? 'bad' : s.short === false ? 'ok' : ''}>
            <small>계획 이행 시</small>
            <b data-testid="summary-projected">{s.projectedAvg ?? '—'}</b>
            <small>{s.projectedAvg != null ? '점' : ''}</small>
          </div>
        </div>
        <p className="day-verdict" data-testid="summary-verdict">
          {s.projectedAvg == null
            ? '학습 계획(시험일)을 정하면 시험일 예상 점수를 알려 드립니다.'
            : s.short == null
              ? '과목마다 10문항 이상 풀면 시험일 예상이 정확해집니다.'
              : s.short
                ? `지금 계획대로면 합격선(과목 ${s.passRule.subjectMin}점·평균 ${s.passRule.avgMin}점)에 못 미칩니다${s.lowSubjects.length ? ` — ${s.lowSubjects.join(', ')}` : ''}. 학습 계획을 고칠까요?`
                : '지금 계획대로면 합격선을 넘습니다. 계획을 고칠까요?'}
        </p>
      </section>

      <section className="actions">
        <button className={`btn btn-block${s.short ? ' btn-primary' : ''}`} onClick={props.onPlan} data-testid="summary-plan">
          학습 계획 고치기
        </button>
        <button className={`btn btn-block${s.short ? '' : ' btn-primary'}`} onClick={props.onHome}>
          그대로 두고 마치기
        </button>
      </section>
    </div>
  );
}
