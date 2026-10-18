import { fmtMinutes, type Coach } from '../coach';

/** 시험일 예상 점수가 이보다 낮으면 "계획 수정 필요" 배지(사용자 결정 — ADR 010) */
export const PLAN_WARN_SCORE = 70;

/**
 * 홈(ADR 010 — 실기기 v0.4.0 의견): 구역을 나눠 "지금 무엇을 할지"가 바로 보이게.
 * ① 시험일 | D-day ② 현재 점수 | 시험일 예상 점수(+ 70점 미만이면 계획 수정 필요 배지)
 * ③ 오늘 학습: 오늘 계획 시간·문항 수와 알고리즘이 정한 구성, [오늘 학습 시작] ④ 다른 방법: 과목 골라서·모의고사
 */
export function CoachCard(props: {
  coach: Coach;
  busy: boolean;
  onPlan: () => void;
  onToday: () => void;
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
  const left = Math.max(0, today.target - coach.doneToday);

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
              계획 수정 필요 ›
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
          <h2>오늘 학습</h2>
          <span className="muted" data-testid="today-plan">
            {fmtMinutes(today.minutes)} · 약 {today.target}문항
          </span>
        </div>
        {open ? (
          <p className="today-what">진행 중인 학습이 있습니다.</p>
        ) : today.size === 0 ? (
          <p className="today-what">오늘 낼 문항을 모두 풀었습니다. 내일 복습이 준비됩니다.</p>
        ) : (
          <ul className="today-what" data-testid="today-what">
            {today.relearn > 0 && <li>오늘 틀린 문항 다시 {today.relearn}</li>}
            {today.bySubject.slice(0, 3).map((b) => (
              <li key={b.name}>
                {b.name} {[b.review && `복습 ${b.review}`, b.fresh && `새 문항 ${b.fresh}`].filter(Boolean).join(' · ')}
              </li>
            ))}
            {today.bySubject.length > 3 && <li className="muted">외 {today.bySubject.length - 3}과목</li>}
          </ul>
        )}
        {open ? (
          <button className="btn btn-primary btn-block btn-big" disabled={props.busy} onClick={() => props.onResume(open.sessionId)} data-testid="today-resume">
            이어서 학습 ({open.left}문항 남음)
          </button>
        ) : (
          <button className="btn btn-primary btn-block btn-big" disabled={props.busy || today.size === 0} onClick={props.onToday} data-testid="today-start">
            {today.extra ? `오늘 계획 완료 · 더 학습하기 (${today.size}문항)` : `오늘 학습 시작 (${today.size}문항)`}
          </button>
        )}
        <div className="today-line">
          <span className="muted" data-testid="week-goal">
            오늘 {coach.doneToday} / {today.target}문항{left === 0 && today.target > 0 ? ' 완료' : ''}
          </span>
          {coach.doneToday > 0 && (
            <button className="link-btn" onClick={props.onFinish} data-testid="finish-day">
              오늘 학습 마치기 ›
            </button>
          )}
        </div>
      </section>

      <nav className="other-ways" aria-label="다른 학습 방법">
        <span className="muted">다른 방법</span>
        <button className="btn btn-small" onClick={props.onSubjects} data-testid="go-subjects">
          과목 골라서
        </button>
        <button className="btn btn-small" onClick={props.onMock} data-testid="tab-mock">
          모의고사
        </button>
      </nav>
    </>
  );
}
