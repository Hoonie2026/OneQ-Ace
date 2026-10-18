import type { Coach } from '../coach';

/**
 * 홈 위쪽(ADR 009 — 실기기 v0.3.0 Q1): 시험일 | D-day, 현재 점수 ☞ 학습계획 이행 시 예상 점수, 오늘 학습(유일한 입구).
 * 설명 문구·합격 가능성 카드는 없앴다(학습에만 집중). 예상이 합격선 아래면 숫자 색으로만 알린다.
 */
export function CoachCard(props: { coach: Coach; busy: boolean; onPlan: () => void; onToday: () => void; onResume: (sessionId: string) => void; onFinish: () => void }) {
  const { coach } = props;
  const { exam, settings, plan } = coach;
  const rule = settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const examDay = settings ? new Date(settings.examDate + 'T00:00').toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }) : null;
  const proj = exam.projectedAvg;
  // 색: 합격선 아래 빨강, 위 초록, 과목 진단 전(10문항 미만)은 색 없음
  const projCls = proj == null || exam.status === 'unknown' ? '' : proj < rule.avgMin || exam.status === 'fail-subject' ? 'bad' : 'ok';
  const open = coach.openToday && coach.openToday.left > 0 ? coach.openToday : null;
  const rec = coach.subjects.find((s) => s.recommended);
  const nothing = !open && coach.order.length === 0;

  return (
    <section className="card coach" data-testid="coach">
      <div className="exam-row">
        <button className="exam-date" onClick={props.onPlan} data-testid="plan-open">
          <small>시험일{settings ? ` · ${settings.examDate.slice(0, 4)}년` : ''}</small>
          <b>{examDay ?? '학습계획 설정'}</b>
          <small className="link">학습계획 ›</small>
        </button>
        <div className="exam-dday">
          <small>오늘 기준</small>
          <b data-testid="dday">{plan ? (plan.daysLeft > 0 ? `D-${plan.daysLeft}` : 'D-day') : '—'}</b>
        </div>
      </div>

      <div className="score-pair" aria-label="현재 점수와 학습계획 이행 시 예상 점수">
        <div>
          <small>현재</small>
          <b data-testid="current-avg">{exam.currentAvg}</b>
          <small>점</small>
        </div>
        <span className="arrow" aria-hidden="true">
          ☞
        </span>
        <div className={projCls}>
          <small>계획 이행 시</small>
          <b data-testid="projected-avg">{proj ?? '—'}</b>
          <small>{proj != null ? '점' : ''}</small>
        </div>
      </div>

      {open ? (
        <button className="btn btn-primary btn-block btn-big" disabled={props.busy} onClick={() => props.onResume(open.sessionId)} data-testid="today-resume">
          {open.title} 이어서 ({open.left}문항 남음)
        </button>
      ) : (
        <button className="btn btn-primary btn-block btn-big" disabled={props.busy || nothing} onClick={props.onToday} data-testid="today-start">
          {nothing ? '오늘 학습할 문항을 모두 풀었습니다' : '오늘 학습 시작'}
          {!nothing && rec && <small className="btn-sub">{rec.name}부터</small>}
        </button>
      )}
      <div className="today-line">
        <span className="muted" data-testid="week-goal">
          오늘 {coach.doneToday}
          {plan ? ` / ${plan.todayTarget}` : ''}문항{plan ? ` · 이번 주 ${plan.doneThisWeek} / ${plan.weeklyGoal}` : ''}
        </span>
        {coach.doneToday > 0 && (
          <button className="link-btn" onClick={props.onFinish} data-testid="finish-day">
            오늘 학습 마치기 ›
          </button>
        )}
      </div>
    </section>
  );
}
