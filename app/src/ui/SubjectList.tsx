import { EXTRA_SIZE, type Coach } from '../coach';
import { Icon } from './Icon';

/**
 * 과목별 학습(ADR 011): 과목마다 학습 이력(현재 점수 → 시험일 예상 점수, 풀이 횟수, 마지막 학습)과 [학습하기].
 * 진도율(풀어 본 문항 비율)은 한 번씩 다 풀면 모두 100%가 되어 의미가 없으므로 쓰지 않고 **점수**로 보여 준다.
 * 학습하기 = 그 과목에서 시스템 추천과 같은 규칙(복습 최대 60% + 새 문항)으로 오늘 남은 목표 문항 수(v0.7.2)
 */
export function SubjectList(props: { coach: Coach; busy: boolean; onStudy: (subjectKey: string) => void }) {
  const { coach } = props;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  // 한 묶음 = 오늘 남은 목표 문항 수(시스템 추천과 같음 — v0.7.2). 목표를 채웠으면 추가 15
  const per = coach.today.extra ? EXTRA_SIZE : Math.max(1, coach.today.target - coach.doneToday);
  const tone = (v: number) => (v < rule.subjectMin ? 'bad' : v < rule.avgMin ? 'warn' : 'ok');
  return (
    <>
      <p className="hint">
        <b>진한 막대 = 현재 점수</b>(지금 시험 보면 — 최근 답 기준, 안 푼 문항·모름·오답 0점). 색은 현재 점수 기준: 과락선 {rule.subjectMin}점 미만 빨강 · {rule.avgMin}점 미만 노랑 · {rule.avgMin}점 이상 초록.
        <br />
        <b>굵은 세로 실선 = 시험일 예상 점수</b>(학습계획대로 공부했을 때 — 계획을 바꾸면 자동 반영). 점선 = 과락선.
      </p>
      <p className="hint">
        학습하기는 {coach.today.extra ? `오늘 목표를 채워 추가 ${EXTRA_SIZE}문항씩` : `오늘 남은 목표 ${per}문항`}을 한 묶음으로 냅니다(시스템 추천 학습과 같음).
      </p>
      <ul className="subjects" data-testid="subject-list">
        {coach.subjects.map((s) => {
          const proj = s.examProjected;
          const { relearn, due, fresh } = s.avail;
          const any = relearn + due + fresh > 0;
          return (
            <li key={s.key} className="card subject" data-testid={`subject-${s.key}`}>
              <div className="subject-head">
                <b>{s.name}</b>
                <span className="subject-score">
                  {s.current}
                  {proj != null && (
                    <>
                      <Icon name="arrow" size={14} className="score-arrow" />
                      <b className={proj < rule.subjectMin ? 'bad' : ''}>{proj}</b>
                    </>
                  )}
                  점
                </span>
              </div>
              {/* v0.7.2(실기기 의견): 막대 = 현재 점수(현재 기준 색), 굵은 실선 = 시험일 예상(계획에서 자동) */}
              <div className="bar dual" role="img" aria-label={`${s.name} 현재 ${s.current}점, 시험일 예상 ${proj ?? '—'}점`} data-testid="subject-bar">
                <span className={`bar-fill ${tone(s.current)}`} style={{ width: `${Math.max(s.current, 0.8)}%` }} data-testid="bar-current" />
                <i className="bar-line pass" style={{ left: `${rule.subjectMin}%` }} />
                {proj != null && (
                  <i className="bar-mark" style={{ left: `${Math.min(99, proj)}%` }} data-testid="bar-projected">
                    <em>예상 {proj}</em>
                  </i>
                )}
              </div>
              <div className="subject-foot">
                <span className="muted">
                  {s.solves ? `풀이 ${s.solves}회 · 마지막 ${new Date(s.lastTs!).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}` : '아직 안 풀었음'}
                  {any ? ` · 오늘 ${relearn + due ? `복습 ${relearn + due} · ` : ''}새 문항 ${fresh}` : ' · 오늘 학습할 문항 없음'}
                </span>
                <button className="btn btn-small btn-primary" disabled={props.busy || !any} onClick={() => props.onStudy(s.key)} data-testid="subject-study">
                  학습하기{any ? ` (${Math.min(per, relearn + due + fresh)}문항)` : ''}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
