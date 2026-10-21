import { useEffect, useState } from 'react';
import { daySummary, fmtMinutes, type DaySummary as S } from '../coach';
import { BackButton } from './Icon';

/**
 * 오늘 학습 기록(ADR 009 → v0.11 ADR 020 → v0.11.1): **오늘 것만** — 목표 진행(푼 수/목표·남은 문항), 오늘 성적(정답 ÷ 푼 문항),
 * 푼·정답·오답·모름, 과목별 오늘(안 푼 과목 0/0). v0.11.1(실기기 의견): 홈의 현재 점수·시험일 예상은 뜻이 달라(전체 기록 기준)
 * 오늘 정답률과 함께 두면 헷갈려 뺐다. 50대 이상도 읽기 쉽게 큰 글자.
 * v0.11부터 "오늘 학습 마치기"는 없고, 홈의 [오늘 기록 보기]로 언제든 본다(묶음을 닫는 일도 하지 않음 — 보기만).
 * 학습 계획 바꾸기는 홈의 "학습계획 설정(재설정)" 한 곳에서(v0.8.1 — 접근 경로 일원화).
 */
export function DaySummary(props: { certCode: string; onHome: () => void }) {
  const [s, setS] = useState<S | null>(null);
  useEffect(() => {
    daySummary(props.certCode).then((x) => (x ? setS(x) : props.onHome()));
  }, [props.certCode]);
  if (!s) return <div className="app" />;
  const rate = s.answered ? Math.round((s.correct / s.answered) * 100) : null;
  const pct = s.target ? Math.min(100, (s.answered / s.target) * 100) : 0;
  const done = s.target > 0 && s.left === 0;
  return (
    <div className="app day-log">
      <header className="page-head">
        <BackButton label="홈" onClick={props.onHome} />
        <h1>오늘 학습 기록</h1>
      </header>

      <section className="card dl-card" data-testid="day-summary">
        <h2>오늘 목표</h2>
        <p className="dl-big" data-testid="day-progress">
          <b>{s.answered}</b>
          <span> / {s.target}문항</span>
        </p>
        <div className="meter dl-meter" aria-hidden="true">
          <div className="meter-bar" style={{ width: `${pct}%` }} />
        </div>
        <p className={`dl-left${done ? ' ok' : ''}`} data-testid="day-left">
          {done ? '오늘 목표를 다 풀었습니다' : `남은 ${s.left}문항 — 홈의 [시스템 추천 학습]으로 이어 갑니다`}
        </p>
        <p className="dl-time">
          공부 시간 <b>{fmtMinutes(s.minutes)}</b> / 계획 {fmtMinutes(s.plannedMinutes)}
        </p>
      </section>

      <section className="card dl-card">
        <h2>오늘 성적</h2>
        <p className="dl-big" data-testid="day-score">
          <b>{rate ?? '—'}</b>
          <span>{rate != null ? '점' : ''}</span>
        </p>
        <p className="dl-sub">오늘 푼 문항 중 정답 비율</p>
        <ul className="dl-tiles">
          <li>
            <small>푼 문항</small>
            <b data-testid="day-answered">{s.answered}</b>
          </li>
          <li className="ok">
            <small>정답</small>
            <b>{s.correct}</b>
          </li>
          <li className="bad">
            <small>오답</small>
            <b>{s.wrong}</b>
          </li>
          <li className="unk">
            <small>모름</small>
            <b>{s.unknown}</b>
          </li>
        </ul>
      </section>

      <section className="card dl-card">
        <h2>과목별 오늘</h2>
        <ul className="dl-subjects" data-testid="day-subjects">
          {s.bySubject.map((b) => (
            <li key={b.name} className={b.answered ? '' : 'none'}>
              <span className="dl-name">{b.name}</span>
              <span className="dl-val">
                <b>
                  {b.correct} / {b.answered}
                </b>
                <small>{b.answered ? `${Math.round((b.correct / b.answered) * 100)}%` : '—'}</small>
              </span>
            </li>
          ))}
        </ul>
        <p className="dl-sub">정답 / 푼 문항. 전체 현재 점수·시험일 예상 점수는 홈에서 봅니다.</p>
      </section>

      <section className="actions">
        <button className="btn btn-block btn-primary btn-big" onClick={props.onHome} data-testid="summary-home">
          홈으로
        </button>
      </section>
    </div>
  );
}
