import { type Coach } from '../coach';
import { GoalTitle } from './GoalTitle';

/**
 * 과목별 학습(ADR 011 → v0.11 ADR 020 → v0.11.4 전면 개편, 실기기 의견): 맨 위 오늘 목표(시스템 추천과 같은 제목·문항 수 계산 안내창),
 * "학습할 과목을 선택하세요", 과목마다 [학습하기 (n문항)]. 막대·과락선·점수·푼 문항 수는 뺐다(점수는 홈의 누적 점수·예상 점수에서).
 * 오늘 목표는 시스템 추천과 **같은 숫자** — 오늘 푼 문항(어느 쪽에서 풀었든) 만큼 줄어든다. n = 남은 문항과 그 과목에 지금 낼 문항 중 적은 쪽
 */
export function SubjectList(props: { coach: Coach; busy: boolean; onStudy: (subjectKey: string) => void }) {
  const { coach } = props;
  const per = Math.max(1, coach.today.left);
  return (
    <section className="card subj-pick" data-testid="subject-list">
      <GoalTitle today={coach.today} />
      <p className="subj-ask">학습할 과목을 선택하세요</p>
      <ul className="subj-rows">
        {coach.subjects.map((s) => {
          const avail = s.avail.relearn + s.avail.due + s.avail.fresh;
          const n = Math.min(per, avail);
          return (
            <li key={s.key} data-testid={`subject-${s.key}`}>
              <span className="subj-name">{s.name}</span>
              <button className="btn btn-primary subj-go" disabled={props.busy || n === 0} onClick={() => props.onStudy(s.key)} data-testid="subject-study">
                {n ? `학습하기 (${n}문항)` : '낼 문항 없음'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
