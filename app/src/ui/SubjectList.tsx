import type { Coach } from '../coach';

/**
 * 과목별 학습(ADR 011): 과목마다 학습 이력(현재 점수 ☞ 시험일 예상 점수, 풀이 횟수, 마지막 학습)과 [학습하기].
 * 진도율(풀어 본 문항 비율)은 한 번씩 다 풀면 모두 100%가 되어 의미가 없으므로 쓰지 않고 **점수**로 보여 준다.
 * 학습하기 = 그 과목에서 시스템 추천과 같은 규칙(복습 최대 60% + 새 문항)으로 15문항
 */
export function SubjectList(props: { coach: Coach; busy: boolean; onStudy: (subjectKey: string) => void }) {
  const { coach } = props;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  return (
    <>
      <p className="hint">
        현재 점수 = 이 과목을 지금 시험 보면(최근 답 기준, 안 푼 문항·모름·오답 0점). 시험일 예상 = 학습계획대로 공부했을 때. 막대의 진한 부분이 현재, 옅은 부분이 시험일 예상, 세로선은 과락선 {rule.subjectMin}점.
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
                      {' ☞ '}
                      <b className={proj < rule.subjectMin ? 'bad' : ''}>{proj}</b>
                    </>
                  )}
                  점
                </span>
              </div>
              <div className="bar dual" role="img" aria-label={`${s.name} 현재 ${s.current}점${proj != null ? `, 시험일 예상 ${proj}점` : ''}`}>
                {proj != null && <span className={`bar-fill ghost${proj < rule.subjectMin ? ' bad' : ''}`} style={{ width: `${proj}%` }} />}
                <span className={`bar-fill${s.current < rule.subjectMin ? ' bad' : s.current < rule.avgMin ? ' warn' : ''}`} style={{ width: `${s.current}%` }} />
                <i className="bar-line" style={{ left: `${rule.subjectMin}%` }} />
              </div>
              <div className="subject-foot">
                <span className="muted">
                  {s.solves ? `풀이 ${s.solves}회 · 마지막 ${new Date(s.lastTs!).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}` : '아직 안 풀었음'}
                  {any ? ` · 오늘 ${relearn + due ? `복습 ${relearn + due} · ` : ''}새 문항 ${fresh}` : ' · 오늘 학습할 문항 없음'}
                </span>
                <button className="btn btn-small btn-primary" disabled={props.busy || !any} onClick={() => props.onStudy(s.key)} data-testid="subject-study">
                  학습하기
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
