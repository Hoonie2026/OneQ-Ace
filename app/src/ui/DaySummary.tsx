import { useEffect, useState } from 'react';
import { daySummary, finishToday, type DaySummary as S } from '../coach';
import { scoreTone } from './CoachCard';
import { BackButton, Icon } from './Icon';

/**
 * 오늘 학습 마치기(ADR 009 — 실기기 v0.3.0 Q5): 오늘 푼 것, 현재 점수 ☞ 계획 이행 시 예상 점수.
 * 학습 계획 바꾸기는 홈의 "학습계획 설정(재설정)" 한 곳에서(v0.8.1 — 접근 경로 일원화).
 */
export function DaySummary(props: { certCode: string; onHome: () => void }) {
  const [s, setS] = useState<S | null>(null);
  useEffect(() => {
    // 오늘 학습 마치기 = 열린 오늘 학습 묶음을 닫는다(기록은 그대로) → 홈은 "시스템 추천 학습"(v0.7.1)
    finishToday(props.certCode)
      .then(() => daySummary(props.certCode))
      .then((x) => (x ? setS(x) : props.onHome()));
  }, [props.certCode]);
  if (!s) return <div className="app" />;
  const rate = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
  return (
    <div className="app">
      <header className="page-head">
        <BackButton label="홈" onClick={props.onHome} />
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
            <Icon name="arrow" size={26} />
          </span>
          <div className={scoreTone(s.projectedAvg)}>
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
                ? `지금 계획대로면 합격선(과목 ${s.passRule.subjectMin}점·평균 ${s.passRule.avgMin}점)에 못 미칩니다${s.lowSubjects.length ? ` — ${s.lowSubjects.join(', ')}` : ''}. 홈의 "학습계획 설정(재설정)"에서 학습시간을 늘려 보세요.`
                : '지금 계획대로면 합격선을 넘습니다.'}
        </p>
      </section>

      <section className="actions">
        <button className="btn btn-block btn-primary" onClick={props.onHome} data-testid="summary-home">
          홈으로
        </button>
      </section>
    </div>
  );
}
