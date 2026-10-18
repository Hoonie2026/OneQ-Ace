import type { Coach } from '../coach';

/**
 * 과목별 학습(ADR 008 — 핵심 학습). 과목마다 전 회차를 하나로 묶어, [학습]을 누르면 자동 순서로 15문항
 * (복습할 때가 된 문항 → 틀린 문항 → 출제빈도 높은 새 문항). 엔진이 고른 과목에 "오늘 추천".
 */
export function SubjectList(props: { coach: Coach; busy: boolean; onStudy: (subjectKey: string) => void }) {
  const { coach } = props;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  return (
    <ul className="subjects" data-testid="subject-list">
      {coach.subjects.map((s) => {
        const proj = s.examProjected;
        const left = s.items - s.seen;
        return (
          <li key={s.key} className={`card subject${s.recommended ? ' is-rec' : ''}`} data-testid={`subject-${s.key}`}>
            <div className="subject-head">
              <b>{s.name}</b>
              {s.recommended && <span className="rec-badge">★ 오늘 추천</span>}
            </div>
            <div className="bar dual" role="img" aria-label={`${s.name} 현재 ${s.current}점${proj != null ? `, 시험일 예상 ${proj}점` : ''}`}>
              {proj != null && <span className={`bar-fill ghost${proj < rule.subjectMin ? ' bad' : ''}`} style={{ width: `${proj}%` }} />}
              <span className={`bar-fill${s.current < rule.subjectMin ? ' bad' : s.current < rule.avgMin ? ' warn' : ''}`} style={{ width: `${s.current}%` }} />
              <i className="bar-line" style={{ left: `${rule.subjectMin}%` }} />
            </div>
            <p className="subject-score">
              현재 <b>{s.current}</b>점{proj != null && <> → 시험일 예상 <b className={proj < rule.subjectMin ? 'bad' : ''}>{proj}</b>점</>}
            </p>
            <p className="meter-text">
              풀어 본 문항 {s.seen}/{s.items}
              {s.due > 0 && ` · 복습할 문항 ${s.due}`}
              {s.newRate.n > 0 && ` · 처음 보는 문항 정답률 ${Math.round(s.newRate.raw * 100)}%`}
            </p>
            <button
              className={`btn btn-block${s.recommended ? ' btn-primary' : ''}`}
              disabled={props.busy || (s.due === 0 && left === 0)}
              onClick={() => props.onStudy(s.key)}
              data-testid="subject-study"
            >
              {s.due === 0 && left === 0 ? '오늘 낼 문항 없음' : `학습 (15문항${s.due ? ` · 복습 ${Math.min(15, s.due)}` : ''})`}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
