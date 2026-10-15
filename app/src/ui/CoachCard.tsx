import { useState } from 'react';
import { applyMinutes, fmtMinutes, type Coach } from '../coach';
import { OUTLOOK_MIN_OBS } from '../engine/outlook';

/**
 * 홈 대시보드(5단계): D-day·예상 점수·합격 기준 경고·이번 주 목표·오늘 학습.
 * 시험일이 없으면 학습 계획을 정하라는 카드만 보인다.
 */
export function CoachCard(props: {
  coach: Coach;
  certCode: string;
  busy: boolean;
  onPlan: () => void;
  onToday: () => void;
  onResumeToday: (sessionId: string) => void;
  onChanged: () => void;
  toast: (m: string) => void;
}) {
  const { coach } = props;
  const [applying, setApplying] = useState(false);
  if (!coach.settings || !coach.plan || !coach.forecast || !coach.outlook) {
    return (
      <section className="card coach" data-testid="coach-setup">
        <h2>시험일부터 정하세요</h2>
        <p className="hint">시험일과 하루 학습시간을 정하면 매일 풀 문항(오늘 학습), 예상 점수, 합격 가능성을 알려 드립니다.</p>
        <button className="btn btn-primary btn-block" onClick={props.onPlan} data-testid="plan-open">
          학습 계획 정하기
        </button>
      </section>
    );
  }
  const { plan, forecast: fc, outlook: ol, settings } = coach;
  const rule = settings.passRule;
  const dday = plan.daysLeft;
  const examDay = new Date(settings.examDate + 'T00:00').toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const weekPct = plan.weeklyGoal ? Math.min(100, (plan.doneThisWeek / plan.weeklyGoal) * 100) : 0;
  const todayLeft = Math.max(0, plan.todayTarget - coach.doneToday);
  const minObs = Math.min(...coach.ctx.bank.subjects.filter((s) => s.current).map((s) => coach.ctx.mem.priorObs.get(s.key) ?? 0));
  const plannedPerDay = ol.daysLeft ? ol.plannedMinutes / ol.daysLeft : 0;

  const apply = async (m: number) => {
    if (!window.confirm(`오늘부터 시험 전날까지 매일 ${fmtMinutes(m)}으로 바꿀까요? (이미 더 길게 정한 날은 그대로)`)) return;
    setApplying(true);
    try {
      await applyMinutes(props.certCode, settings, m);
      props.toast(`남은 ${ol.daysLeft}일 학습시간을 하루 ${fmtMinutes(m)}으로 바꿨습니다`);
      props.onChanged();
    } finally {
      setApplying(false);
    }
  };

  // 합격 기준 경고 문구
  let warnCls = 'ok';
  let headline: string;
  let detail: string | null = null;
  if (ol.status === 'unknown') {
    warnCls = 'idle';
    headline = '실력을 파악하는 중입니다';
    detail = `과목마다 ${OUTLOOK_MIN_OBS}문항 이상 풀면 합격 가능성을 알려 드립니다(지금 가장 적은 과목 ${minObs}문항).`;
  } else if (ol.status === 'pass') {
    headline = `지금 계획대로면 합격권입니다 · 시험일 예상 ${ol.projectedAverage}점`;
  } else {
    warnCls = ol.status === 'tight' ? 'warn' : 'bad';
    headline =
      ol.status === 'fail-subject'
        ? `지금 계획으로는 과락이 예상됩니다 · ${ol.failSubjects.join(', ')}`
        : ol.status === 'avg-short'
          ? `지금 계획으로는 평균 ${rule.avgMin}점에 못 미칩니다 · 예상 ${ol.projectedAverage}점`
          : `합격선 근처입니다 · 예상 ${ol.projectedAverage}점`;
  }

  return (
    <section className="card coach" data-testid="coach">
      <div className="coach-top">
        <div>
          <p className="dday" data-testid="dday">
            {dday > 0 ? `D-${dday}` : 'D-day'}
          </p>
          <button className="link-btn" onClick={props.onPlan}>
            시험 {examDay} · 하루 {fmtMinutes(settings.dailyMinutes)} ›
          </button>
        </div>
        <div className={`avg-badge ${fc.overall === 'safe' ? 'ok' : fc.overall === 'avg-short' ? 'warn' : 'bad'}`} data-testid="forecast-avg">
          <small>지금 예상</small>
          <b>{fc.average}</b>
          <small>점</small>
        </div>
      </div>

      <ul className="mini-bars" aria-label="과목별 예상 점수">
        {fc.subjects.map((s) => (
          <li key={s.key}>
            <span className="mini-name">{s.name}</span>
            <span className="bar" role="img" aria-label={`${s.name} 예상 ${s.score}점`}>
              <span className={`bar-fill${s.score < rule.subjectMin ? ' bad' : s.score < rule.avgMin ? ' warn' : ''}`} style={{ width: `${s.score}%` }} />
              <i className="bar-line" style={{ left: `${rule.subjectMin}%` }} />
            </span>
            <b className={s.score < rule.subjectMin ? 'bad' : ''}>{Math.round(s.score)}</b>
          </li>
        ))}
      </ul>
      <p className="hint">지금 멈추면 받을 점수(보유 기출 기준). 세로선은 과락선 {rule.subjectMin}점.</p>

      <div className={`outlook ${warnCls}`} data-testid="outlook" data-status={ol.status}>
        <p className="outlook-head">{headline}</p>
        {detail && <p>{detail}</p>}
        {ol.status !== 'unknown' && ol.status !== 'pass' && (
          <>
            {ol.minMinutesPerDay != null ? (
              <p data-testid="outlook-minutes">
                남은 {ol.daysLeft}일 동안 매일 <b>최소 {fmtMinutes(ol.minMinutesPerDay)}</b>
                {ol.neededMinutesPerDay != null && ol.neededMinutesPerDay > ol.minMinutesPerDay && <> · 여유 있게 {fmtMinutes(ol.neededMinutesPerDay)}</>} 공부해야 합격이
                가능합니다(지금 계획 하루 평균 {fmtMinutes(Math.round(plannedPerDay))}).
              </p>
            ) : (
              <p data-testid="outlook-minutes">남은 기출 문항을 모두 익혀도 합격선에 닿기 어려운 상태입니다. 남은 기간 매일 할 수 있는 만큼 공부하세요.</p>
            )}
            {ol.fixMinutesPerDay != null && ol.failSubjects.length > 0 && (
              <p className="hint">과락만 벗어나려면 매일 {fmtMinutes(ol.fixMinutesPerDay)}.</p>
            )}
            {ol.neededMinutesPerDay != null && ol.neededMinutesPerDay > plannedPerDay && (
              <button className="btn btn-small" disabled={applying} onClick={() => apply(ol.neededMinutesPerDay!)} data-testid="apply-minutes">
                남은 날 매일 {fmtMinutes(ol.neededMinutesPerDay)}으로 바꾸기
              </button>
            )}
          </>
        )}
      </div>

      <div className="week">
        <div className="score-head">
          <h2>이번 주 목표</h2>
          <p className="muted" data-testid="week-goal">
            {plan.doneThisWeek} / {plan.weeklyGoal}문항
          </p>
        </div>
        <div className="meter" aria-label={`이번 주 ${plan.doneThisWeek}/${plan.weeklyGoal}`}>
          <div className="meter-bar" style={{ width: `${weekPct}%` }} />
        </div>
        <p className="meter-text">
          오늘 {coach.doneToday}문항 풀이 · 오늘 학습시간 {fmtMinutes(plan.todayMinutes)}(약 {plan.todayTarget}문항)
          {todayLeft > 0 ? ` · ${todayLeft}문항 남음` : plan.todayTarget > 0 ? ' · 오늘 목표 달성' : ''}
        </p>
      </div>

      {coach.openToday && coach.openToday.left > 0 ? (
        <button className="btn btn-primary btn-block btn-big" disabled={props.busy} onClick={() => props.onResumeToday(coach.openToday!.sessionId)} data-testid="today-resume">
          오늘 학습 이어서 ({coach.openToday.left}문항 남음)
        </button>
      ) : (
        <button className="btn btn-primary btn-block btn-big" disabled={props.busy || dday <= 0} onClick={props.onToday} data-testid="today-start">
          오늘 학습 시작 (15문항)
        </button>
      )}
    </section>
  );
}
