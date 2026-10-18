import type { Coach } from '../coach';

/**
 * 과목별(ADR 008·009): 과목마다 현재 → 계획 이행 시 예상. [학습]은 그 과목만 골라 공부하고 싶을 때(오늘 학습과 같은 규칙:
 * 오늘 틀린 문항 다시 → 복습할 때가 된 문항 → 출제빈도 높은 새 문항). 매일의 기본 입구는 홈의 "오늘 학습" 하나다.
 */
export function SubjectList(props: { coach: Coach; busy: boolean; onStudy: (subjectKey: string) => void }) {
  const { coach } = props;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  return (
    <ul className="subjects" data-testid="subject-list">
      {coach.subjects.map((s) => {
        const proj = s.examProjected;
        const { relearn, due, fresh } = s.avail;
        const any = relearn + due + fresh > 0;
        const parts = [relearn && `다시 ${relearn}`, due && `복습 ${due}`, fresh && `새 문항 ${fresh}`].filter(Boolean);
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
            <div className="bar dual" role="img" aria-label={`${s.name} 현재 ${s.current}점${proj != null ? `, 계획 이행 시 ${proj}점` : ''}`}>
              {proj != null && <span className={`bar-fill ghost${proj < rule.subjectMin ? ' bad' : ''}`} style={{ width: `${proj}%` }} />}
              <span className={`bar-fill${s.current < rule.subjectMin ? ' bad' : s.current < rule.avgMin ? ' warn' : ''}`} style={{ width: `${s.current}%` }} />
              <i className="bar-line" style={{ left: `${rule.subjectMin}%` }} />
            </div>
            <div className="subject-foot">
              <span className="muted">{any ? `오늘 ${parts.join(' · ')}` : '오늘 학습할 문항 없음'}</span>
              <button className="btn btn-small" disabled={props.busy || !any} onClick={() => props.onStudy(s.key)} data-testid="subject-study">
                이 과목만
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
