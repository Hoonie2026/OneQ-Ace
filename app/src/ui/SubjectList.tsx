import { type Coach } from '../coach';
import { GoalTitle } from './GoalTitle';
import { Icon } from './Icon';

/**
 * 과목별 학습(ADR 011 → v0.11 ADR 020 → v0.11.4 → v0.16 디자인 정리, 사용자 2026-11-16):
 * 오늘 목표 → "학습할 과목을 선택하세요" → 과목마다 한 줄 전체가 누르는 단추(번호 · 과목명 · "n문항 풀기" · ›).
 * 과목명 길이와 관계없이 같은 모양 — 과목명은 위 줄, 문항 수는 아래 작은 글자. 단원·유형별 학습은 없앰(ADR 025).
 * 오늘 목표는 시스템 추천과 같은 숫자 — n = 남은 문항과 그 과목에 지금 낼 문항 중 적은 쪽
 */
export function SubjectList(props: { coach: Coach; busy: boolean; onStudy: (subjectKey: string) => void; onStandard?: () => void }) {
  const { coach } = props;
  const per = Math.max(1, coach.today.left);
  return (
    <section className="card subj-pick" data-testid="subject-list">
      <GoalTitle today={coach.today} />
      <p className="subj-ask">학습할 과목을 선택하세요</p>
      <ul className="subj-rows">
        {coach.subjects.map((s, i) => {
          const avail = s.avail.relearn + s.avail.due + s.avail.fresh;
          const n = Math.min(per, avail);
          return (
            <li key={s.key} data-testid={`subject-${s.key}`}>
              <button className="subj-row" disabled={props.busy || n === 0} onClick={() => props.onStudy(s.key)} data-testid="subject-study">
                <span className="subj-no" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="subj-body">
                  <span className="subj-name">{s.name}</span>
                  <small className="subj-sub">{n ? `${n}문항 풀기` : '지금 낼 문항 없음'}</small>
                </span>
                <Icon name="forward" size={20} className="subj-arrow" />
              </button>
            </li>
          );
        })}
      </ul>
      {props.onStandard && (
        <button className="link-btn center-link" onClick={props.onStandard} data-testid="open-standard">
          이 종목 출제기준 보기 <Icon name="forward" size={16} />
        </button>
      )}
    </section>
  );
}
