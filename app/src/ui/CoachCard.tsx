import { fmtMinutes, type Coach } from '../coach';
import type { Insight } from '../insight';
import { Icon } from './Icon';

/**
 * 시험일 예상 점수 색(v0.8.1 — 사용자 결정, "계획 수정 필요" 배지 대신): 60점 미만 빨강 · 75점 미만 주황 · 75점 이상 초록.
 * 학습 계획 미리보기도 같은 색을 쓴다
 */
export const SCORE_RED = 60;
export const SCORE_GREEN = 75;
export function scoreTone(score: number | null): '' | 'bad' | 'warn' | 'ok' {
  if (score == null) return '';
  return score < SCORE_RED ? 'bad' : score < SCORE_GREEN ? 'warn' : 'ok';
}

/**
 * 홈(ADR 011 — 실기기 v0.5.0 의견):
 * ① 시험일 | D-day ② 현재 점수 | 시험일 예상 점수
 * ③ 오늘 학습 목표(계획 시간·문항) — [시스템 추천 학습] [과목별 학습] ④ 모의고사(이력은 따로)
 */
export function CoachCard(props: {
  coach: Coach;
  /** 학습 점검(실제 학습량 — ADR 014). 계산이 무거워 홈을 먼저 그린 뒤 채운다 */
  insight: Insight | null;
  onForecast: () => void;
  onPrinciples: () => void;
  busy: boolean;
  lastMock: { date: string; score: number } | null;
  onPlan: () => void;
  onRecommend: () => void;
  /** 오늘 기록 보기(v0.11 — "오늘 학습 마치기" 대신) */
  onDayLog: () => void;
  onSubjects: () => void;
  onMock: () => void;
}) {
  const { coach } = props;
  const { exam, settings, plan, today } = coach;
  const examDay = settings ? new Date(settings.examDate + 'T00:00').toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }) : null;
  const proj = exam.projectedAvg;
  const projCls = scoreTone(proj);
  const left = Math.max(0, today.target - coach.doneToday);
  const pct = today.target ? Math.min(100, (coach.doneToday / today.target) * 100) : 0;

  return (
    // v0.10: 태블릿 가로·PC(폭 960px 이상)에서는 두 단 — 왼쪽 시험일·점수·점검, 오른쪽 오늘 학습·모의고사·원리. 휴대폰은 한 단 그대로
    <div className="home-grid">
      <div className="home-col">
      <section className="card exam-row" data-testid="coach">
        <button className="exam-date" onClick={props.onPlan} data-testid="plan-open">
          <small>시험일{settings ? ` · ${settings.examDate.slice(0, 4)}년` : ''}</small>
          <b>{examDay ?? '아직 정하지 않음'}</b>
          <span className="plan-link">학습계획 설정(재설정)</span>
        </button>
        <div className="exam-dday">
          <small>오늘 기준</small>
          <b data-testid="dday">{plan ? (plan.daysLeft > 0 ? `D-${plan.daysLeft}` : 'D-day') : '—'}</b>
        </div>
      </section>

      <section className="score-boxes" aria-label="누적 점수와 시험일 예상 점수">
        <div className="card score-box">
          <small>누적 점수</small>
          <p>
            <b data-testid="current-avg">{exam.current ?? '—'}</b>
            {exam.current != null ? '점' : ''}
          </p>
          <small className="muted score-note" data-testid="current-basis">
            {exam.solved ? `푼 ${exam.solved}문항 중 정답 ${exam.correct}` : '문제를 풀면 표시'}
          </small>
        </div>
        <div className={`card score-box ${projCls}`}>
          <small>시험일 예상 점수</small>
          <p>
            <b data-testid="projected-avg">{proj ?? '—'}</b>
            {proj != null ? '점' : ''}
          </p>
          {proj != null ? (
            <button className="link-btn small" onClick={props.onForecast} data-testid="forecast-open">
              계산 보기 <Icon name="forward" size={16} />
            </button>
          ) : (
            <small className="muted">시험일을 정하면 표시</small>
          )}
        </div>
      </section>

      {props.insight && <InsightCard insight={props.insight} />}
      </div>
      <div className="home-col">

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
        {/* v0.11(ADR 020): 학습 방식은 세 가지 — 시스템 추천 · 과목별 · 모의고사. "이어서 학습"·"오늘 학습 마치기" 없음.
            답은 바로 저장되고, 시작할 때마다 오늘 남은 목표만큼 오늘 기록으로 다시 고른다(날이 바뀌면 새로) */}
        <button className="btn btn-primary btn-block btn-big btn-stack" disabled={props.busy} onClick={props.onRecommend} data-testid="go-recommend">
          시스템 추천 학습
          <small className="btn-sub" data-testid="go-recommend-sub">
            {left > 0 ? `오늘 남은 ${left}문항` : '오늘 목표 완료 · 추가 학습'}
          </small>
        </button>
        <button className="btn btn-block" onClick={props.onSubjects} data-testid="go-subjects">
          과목별 학습
        </button>
        {coach.doneToday > 0 && (
          <button className="link-btn center-link" onClick={props.onDayLog} data-testid="day-log">
            오늘 기록 보기 <Icon name="forward" size={16} />
          </button>
        )}
      </section>

      <section className="card mock-card">
        <div className="today-head">
          <h2>모의고사</h2>
          <span className="muted">{props.lastMock ? `최근 ${props.lastMock.date} · ${props.lastMock.score}점` : '아직 안 봄'}</span>
        </div>
        <p className="hint">지금 실력 확인용. 성적은 모의고사 이력에만 남고 누적 점수·학습 추천에는 넣지 않습니다.</p>
        <button className="btn btn-block" onClick={props.onMock} data-testid="tab-mock">
          모의고사
        </button>
      </section>

      <button className="card principles-btn" onClick={props.onPrinciples} data-testid="principles-open">
        <span className="principles-ico" aria-hidden="true">
          <Icon name="book" size={24} />
        </span>
        <span>
          <b>학습 원리 · 예상 점수 계산 방법</b>
          <small>이 앱이 문항을 고르고 점수를 예상하는 방법과 그 근거(연구)</small>
        </span>
        <Icon name="forward" size={20} />
      </button>
      </div>
    </div>
  );
}

/**
 * 학습 점검 카드(ADR 014 — 사용자 요청: 계획·남은 기간·지금까지 학습 패턴으로 볼 때 개선 없이는 합격이 어려우면 경고).
 * 위험(과락·평균 미달)·아슬아슬하거나, 최근 실제 학습량이 계획보다 적을 때만 보인다.
 * 학습 계획 바꾸기는 홈 위 "학습계획 설정(재설정)" 한 곳에서(v0.8.1 — 접근 경로 일원화)
 */
export function InsightCard(props: { insight: Insight }) {
  const { level, plan, pace, atPace, need, dailyMinutes } = props.insight;
  const behind = !!atPace;
  if (!(level === 'risk' || level === 'watch' || behind)) return null;
  const title =
    level === 'risk' ? '지금대로면 합격이 어렵습니다' : level === 'watch' ? '합격선에 아슬아슬합니다' : '계획보다 공부량이 적습니다';
  return (
    <section className={`card insight-card ${level === 'risk' ? 'bad' : 'warn'}`} data-testid="insight-card" role="status">
      <h2>
        <Icon name="alert" size={20} /> {title}
      </h2>
      <ul>
        {pace && (
          <li data-testid="insight-pace">
            최근 {pace.days}일 하루 평균 <b>{fmtMinutes(pace.minutesPerDay)}</b> 공부 — 계획({fmtMinutes(pace.plannedPerDay)})의 {Math.round(pace.ratio * 100)}%
          </li>
        )}
        {atPace && (
          <li data-testid="insight-atpace">
            이 속도면 시험일 예상 <b>{atPace.avg}점</b>
            {atPace.fail.length > 0 && <> · 과락 위험 {atPace.fail.join(', ')}</>}
          </li>
        )}
        {plan && (
          <li>
            계획대로 하면 {plan.avg}점
            {plan.fail.length > 0 && <> · 과락 위험 {plan.fail.join(', ')}</>}
          </li>
        )}
        {need.safe != null ? (
          <li data-testid="insight-need">
            여유 있게 합격하려면 평소 하루 <b>{fmtMinutes(need.safe)}</b>
            {need.min != null && need.min < need.safe && <> (최소 {fmtMinutes(need.min)})</>}
            {dailyMinutes > 0 && need.safe > dailyMinutes && <> — 지금 계획 {fmtMinutes(dailyMinutes)}</>}
          </li>
        ) : (
          (level === 'risk' || level === 'watch') && (
            <li data-testid="insight-need">하루 8시간으로도 여유 있는 합격선에 닿기 어렵습니다 — 기출 회차를 더 넣거나 시험일을 다시 생각해 보세요.</li>
          )
        )}
        {!pace && <li className="muted">실제 학습량은 기록이 3일 이상 쌓이면 함께 반영합니다.</li>}
      </ul>
      <p className="hint">학습 계획은 위 "학습계획 설정(재설정)"에서 바꿉니다.</p>
    </section>
  );
}
