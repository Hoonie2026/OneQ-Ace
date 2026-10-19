import { fmtMinutes, type Coach } from '../coach';

/** 시험일 예상 점수가 이보다 낮으면 "계획 수정 필요" 배지(사용자 결정 — ADR 010) */
export const PLAN_WARN_SCORE = 70;

/**
 * 홈(ADR 011 — 실기기 v0.5.0 의견):
 * ① 시험일 | D-day ② 현재 점수 | 시험일 예상 점수
 * ③ 오늘 학습 목표(계획 시간·문항) — [시스템 추천 학습] [과목별 학습] ④ 모의고사(이력은 따로)
 */
export function CoachCard(props: {
  coach: Coach;
  busy: boolean;
  lastMock: { date: string; score: number } | null;
  onPlan: () => void;
  onRecommend: () => void;
  onResume: (sessionId: string) => void;
  onFinish: () => void;
  onSubjects: () => void;
  onMock: () => void;
}) {
  const { coach } = props;
  const { exam, settings, plan, today } = coach;
  const rule = settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const examDay = settings ? new Date(settings.examDate + 'T00:00').toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }) : null;
  const proj = exam.projectedAvg;
  const projCls = proj == null || exam.status === 'unknown' ? '' : proj < rule.avgMin || exam.status === 'fail-subject' ? 'bad' : 'ok';
  const warn = proj != null && proj < PLAN_WARN_SCORE;
  const open = coach.openToday && coach.openToday.left > 0 ? coach.openToday : null;
  const pct = today.target ? Math.min(100, (coach.doneToday / today.target) * 100) : 0;

  return (
    <>
      <section className="card exam-row" data-testid="coach">
        <button className="exam-date" onClick={props.onPlan} data-testid="plan-open">
          <small>시험일{settings ? ` · ${settings.examDate.slice(0, 4)}년` : ''}</small>
          <b>{examDay ?? '아직 정하지 않음'}</b>
          <small className="link">학습계획 설정 및 재설정 ›</small>
        </button>
        <div className="exam-dday">
          <small>오늘 기준</small>
          <b data-testid="dday">{plan ? (plan.daysLeft > 0 ? `D-${plan.daysLeft}` : 'D-day') : '—'}</b>
        </div>
      </section>

      <section className="score-boxes" aria-label="현재 점수와 시험일 예상 점수">
        <div className="card score-box">
          <small>현재 점수</small>
          <p>
            <b data-testid="current-avg">{exam.currentAvg}</b>점
          </p>
        </div>
        <div className={`card score-box ${projCls}`}>
          <small>시험일 예상 점수</small>
          <p>
            <b data-testid="projected-avg">{proj ?? '—'}</b>
            {proj != null ? '점' : ''}
          </p>
          {warn && (
            <button className="warn-badge" onClick={props.onPlan} data-testid="plan-warn">
              계획 수정 필요({PLAN_WARN_SCORE}점 이상) ›
            </button>
          )}
          {proj == null && (
            <button className="link-btn small" onClick={props.onPlan}>
              시험일을 정하면 표시 ›
            </button>
          )}
        </div>
      </section>

      <section className="card today-card" data-testid="today-card">
        <div className="today-head">
          <h2>오늘 학습 목표</h2>
          <span className="today-goal" data-testid="today-plan">
            {fmtMinutes(today.minutes)} · {today.target}문항
          </span>
        </div>
        <div className="meter" aria-label={`오늘 ${coach.doneToday}/${today.target}문항`}>
          <div className="meter-bar" style={{ width: `${pct}%` }} />
        </div>
        <p className="meter-text" data-testid="week-goal">
          오늘 {coach.doneToday} / {today.target}문항{coach.doneToday >= today.target && today.target > 0 ? ' 완료' : ''}
        </p>
        {open ? (
          <button className="btn btn-primary btn-block btn-big" disabled={props.busy} onClick={() => props.onResume(open.sessionId)} data-testid="today-resume">
            이어서 학습 ({open.left}문항 남음)
          </button>
        ) : (
          <button className="btn btn-primary btn-block btn-big" disabled={props.busy} onClick={props.onRecommend} data-testid="go-recommend">
            시스템 추천 학습 ›
          </button>
        )}
        <button className="btn btn-block" onClick={props.onSubjects} data-testid="go-subjects">
          과목별 학습 ›
        </button>
        {coach.doneToday > 0 && (
          <button className="link-btn center-link" onClick={props.onFinish} data-testid="finish-day">
            오늘 학습 마치기 ›
          </button>
        )}
      </section>

      <section className="card mock-card">
        <div className="today-head">
          <h2>모의고사</h2>
          <span className="muted">{props.lastMock ? `최근 ${props.lastMock.date} · ${props.lastMock.score}점` : '아직 안 봄'}</span>
        </div>
        <p className="hint">지금 실력 확인용. 성적은 모의고사 이력에만 남고 현재 점수·학습 추천에는 넣지 않습니다.</p>
        <button className="btn btn-block" onClick={props.onMock} data-testid="tab-mock">
          모의고사 ›
        </button>
      </section>
    </>
  );
}
