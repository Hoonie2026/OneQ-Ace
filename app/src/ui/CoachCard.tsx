import { useState } from 'react';
import { applyMinutes, fmtMinutes, type Coach } from '../coach';
import { OUTLOOK_MIN_OBS } from '../engine/outlook';

/**
 * 홈 위쪽(ADR 008): D-day, 현재 점수 → 시험일 예상(실제 시험 기준), 합격 가능성(항상 보임), 이번 주 목표.
 * 시험일이 없으면 현재 점수와 학습 계획을 정하라는 안내만.
 */
export function CoachCard(props: {
  coach: Coach;
  certCode: string;
  onPlan: () => void;
  onResume: (sessionId: string) => void;
  onChanged: () => void;
  toast: (m: string) => void;
}) {
  const { coach } = props;
  const { exam } = coach;
  const [applying, setApplying] = useState(false);
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const resume = coach.openToday && coach.openToday.left > 0 && (
    <button className="btn btn-primary btn-block" onClick={() => props.onResume(coach.openToday!.sessionId)} data-testid="today-resume">
      {coach.openToday.title} 이어서 ({coach.openToday.left}문항 남음)
    </button>
  );

  if (!coach.settings || !coach.plan || !coach.outlook || exam.projectedAvg == null) {
    return (
      <section className="card coach" data-testid="coach-setup">
        <div className="score-pair">
          <div>
            <small>현재</small>
            <b data-testid="current-avg">{exam.currentAvg}</b>
            <small>점</small>
          </div>
        </div>
        <h2>시험일부터 정하세요</h2>
        <p className="hint">시험일과 하루 학습시간을 정하면 시험일 예상 점수와 합격 가능성, 하루에 필요한 학습시간을 알려 드립니다.</p>
        <button className="btn btn-primary btn-block" onClick={props.onPlan} data-testid="plan-open">
          학습 계획 정하기
        </button>
        {resume}
      </section>
    );
  }
  const { plan, outlook: ol, settings } = coach;
  const examDay = new Date(settings.examDate + 'T00:00').toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const weekPct = plan.weeklyGoal ? Math.min(100, (plan.doneThisWeek / plan.weeklyGoal) * 100) : 0;
  const plannedPerDay = ol.daysLeft ? ol.plannedMinutes / ol.daysLeft : 0;
  const minObs = Math.min(...coach.subjects.map((s) => coach.ctx.mem.priorObs.get(s.key) ?? 0));
  const cover = ol.coverMinutesPerDay;
  const cls = exam.status === 'pass' ? 'ok' : exam.status === 'tight' ? 'warn' : exam.status === 'unknown' ? 'idle' : 'bad';
  const projCls = exam.projectedAvg >= rule.avgMin && exam.status !== 'fail-subject' ? 'ok' : exam.status === 'unknown' ? '' : 'bad';

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

  return (
    <section className="card coach" data-testid="coach">
      <div className="coach-top">
        <p className="dday" data-testid="dday">
          {plan.daysLeft > 0 ? `D-${plan.daysLeft}` : 'D-day'}
        </p>
        <button className="link-btn" onClick={props.onPlan}>
          시험 {examDay} · 하루 {fmtMinutes(settings.dailyMinutes)} ›
        </button>
      </div>

      <div className="score-pair" aria-label="현재 점수와 시험일 예상 점수">
        <div>
          <small>현재</small>
          <b data-testid="current-avg">{exam.currentAvg}</b>
          <small>점</small>
        </div>
        <span className="arrow" aria-hidden="true">
          →
        </span>
        <div className={projCls}>
          <small>시험일 예상</small>
          <b data-testid="projected-avg">{exam.projectedAvg}</b>
          <small>점</small>
        </div>
      </div>
      <p className="hint">현재 = 지금까지 답한 그대로(안 푼 문항·모름·오답 0점). 예상 = 계획대로 공부하고 실제 시험을 봤을 때(과목 평균).</p>

      <div className={`outlook ${cls}`} data-testid="outlook" data-status={exam.status}>
        <p className="outlook-title">합격 가능성</p>
        {exam.status === 'unknown' ? (
          <p className="outlook-head">
            실력을 파악하는 중입니다 — 과목마다 {OUTLOOK_MIN_OBS}문항 이상 풀면 알려 드립니다(지금 가장 적은 과목 {minObs}문항)
          </p>
        ) : exam.status === 'pass' ? (
          <p className="outlook-head">계획대로면 합격권입니다</p>
        ) : (
          <>
            <p className="outlook-head">
              {exam.status === 'fail-subject'
                ? `과락 예상 · ${exam.failSubjects.join(', ')}`
                : exam.status === 'avg-short'
                  ? `평균 ${rule.avgMin}점에 못 미칠 것으로 예상됩니다`
                  : '합격선 근처입니다'}
            </p>
            {coach.subjects
              .filter((s) => s.examProjected != null && s.examProjected < rule.subjectMin && s.needNewRate != null)
              .map((s) => (
                <p key={s.key}>
                  {s.name}: 처음 보는 문항 정답률 {Math.round(s.newRate.exam * 100)}% → 과락을 벗어나려면 {Math.round(s.needNewRate! * 100)}% 이상
                </p>
              ))}
          </>
        )}
        {exam.status !== 'unknown' && cover != null && (
          <p data-testid="outlook-minutes">
            남은 {ol.daysLeft}일 동안 매일 <b>최소 {fmtMinutes(Math.max(1, cover))}</b>이면 보유 기출({exam.rounds}회차) 전체를 시험 전에 익힐 수 있습니다
            (지금 계획 하루 평균 {fmtMinutes(Math.round(plannedPerDay))}).
          </p>
        )}
        {exam.status !== 'unknown' && exam.status !== 'pass' && cover != null && cover > plannedPerDay && (
          <button className="btn btn-small" disabled={applying} onClick={() => apply(cover)} data-testid="apply-minutes">
            남은 날 매일 {fmtMinutes(cover)}으로 바꾸기
          </button>
        )}
        <p className="hint">
          실제 시험은 처음 보는 문항이 대부분입니다. 같은 문항이 다시 나오는 비율 {Math.round(exam.rho * 100)}%
          {exam.rounds < 5 ? '(회차가 적어 측량기사 34회차 실측 기준)' : `(보유 ${exam.rounds}회차 실측)`}, 나머지는 처음 보는 문항 정답률로 예상하고, 모름은 찍어서 25%로 셉니다.
        </p>
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
        </p>
      </div>
      {resume}
    </section>
  );
}
