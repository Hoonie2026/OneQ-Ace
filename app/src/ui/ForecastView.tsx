import type { Coach } from '../coach';
import { examScoreMix, projectedRate, TRANSFER, TRANSFER_REF_ITEMS } from '../engine/exam';
import { LATE_R } from '../engine/outlook';
import { VARIANT_TRANSFER } from '../engine/similar';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * 시험일 예상 점수 계산 보기(ADR 014 — v0.8.2 실기기 의견 X2: 두괄식·개조식, 수식 반복 없이).
 * ① 핵심(예상 점수 · 기출/처음 보는 문항 몫 · 지금 정답률로 오를 수 있는 최고 점수) ② 과목별 표(+ 평균 = 홈 점수) ③ 자주 묻는 질문 ④ 한계
 */
export function ForecastView(props: { coach: Coach }) {
  const { coach } = props;
  const { exam, subjects } = coach;
  const sh = exam.shares;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const rows = subjects.filter((s) => s.examProjected != null && s.bankProjected != null && s.rateProjected != null);
  // 보유 기출을 모두 익혀 시험 직전까지 기억할 때(LATE_R, 지금 처음 보는 문항 정답률 기준)의 시험 점수 — 학습시간을 아무리 늘려도 넘을 수 없는 선
  const ceiling = r1(
    mean(
      subjects.map((s) => {
        const bank = 100 * (LATE_R + (1 - LATE_R) * s.newRate.exam);
        return examScoreMix(bank, projectedRate(s.newRate, Math.min(1, s.items / TRANSFER_REF_ITEMS)), sh);
      }),
    ),
  );
  const nowRate = mean(subjects.map((s) => s.newRate.exam));
  const measured = subjects.some((s) => s.newRate.n > 0);

  return (
    <section className="stack forecast" data-testid="forecast-view">
      <div className="card" data-testid="forecast-key">
        <h2>
          시험일 예상 <span className="big-num">{exam.projectedAvg ?? '—'}</span>점
        </h2>
        <ul className="headline">
          <li>학습계획대로 공부했을 때 {subjects.length}과목 예상 점수의 평균입니다.</li>
          <li>
            실제 시험 문항 = 기출(같은 문항 {pct(sh.same)} + 변형 {pct(sh.variant)}) + <b>처음 보는 문항 {pct(sh.fresh)}</b>
            <small className="muted"> — 보유 기출 {exam.rounds}회차 기준 실측</small>
          </li>
          <li>기출 몫은 공부할수록 오르고, 처음 보는 문항 몫은 내가 처음 보는 문제를 맞히는 비율(지금 {pct(nowRate)})에 달려 있습니다.</li>
          <li data-testid="forecast-ceiling">
            그래서 기출을 모두 익혀 시험날까지 기억해도 지금 정답률로는 <b>약 {ceiling}점</b>이 최고입니다. 처음 보는 문제를 더 맞히게 되면 이 선도 함께 오릅니다.
          </li>
        </ul>
        {exam.status === 'unknown' && <p className="hint">과목마다 처음 푼 문항이 10개가 안 돼 진단 중 — 숫자가 크게 바뀔 수 있습니다.</p>}
        {!measured && <p className="hint">아직 풀이 기록이 없어 처음 보는 문항 정답률을 찍기(25%)로 계산했습니다.</p>}
      </div>

      <div className="card">
        <h3>과목별 예상(계획대로)</h3>
        <table className="mini-table calc-table" data-testid="forecast-table">
          <thead>
            <tr>
              <th>과목</th>
              <th>기출 점수</th>
              <th>처음 보는 문항</th>
              <th>시험 예상</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((s) => (
              <tr key={s.key}>
                <td>{s.name}</td>
                <td>{s.bankProjected != null ? r1(s.bankProjected) : '—'}</td>
                <td>{s.rateProjected != null ? pct(s.rateProjected) : '—'}</td>
                <td className={s.examProjected != null && s.examProjected < rule.subjectMin ? 'bad' : ''}>
                  <b>{s.examProjected ?? '—'}</b>
                </td>
              </tr>
            ))}
            {rows.length === subjects.length && rows.length > 0 && (
              <tr className="avg-row" data-testid="forecast-avg">
                <td>평균(홈 점수)</td>
                <td>{r1(mean(rows.map((s) => s.bankProjected!)))}</td>
                <td>{pct(mean(rows.map((s) => s.rateProjected!)))}</td>
                <td>{exam.projectedAvg}</td>
              </tr>
            )}
          </tbody>
        </table>
        <ul className="plain">
          <li>기출 점수: 보유 기출을 시험일에 다시 풀면 맞힐 비율</li>
          <li>처음 보는 문항: 한 번도 안 본 문제를 맞힐 비율</li>
          <li>시험 예상: 두 값을 ① 문항 구성 비율대로 섞은 값 · {rule.subjectMin}점 미만 빨강</li>
        </ul>
      </div>

      <div className="card">
        <h3>자주 묻는 질문</h3>
        <ul className="plain faq">
          <li>
            <b>몇 회독을 해야 점수에 반영되나요?</b>
            <br />
            회독 수가 아니라 문항마다 <b>맞혔는지·언제 풀었는지</b>로 계산합니다(FSRS 기억 모형). 3회독이라도 틀린 문항은 낮게, 간격을 두고 거듭 맞힌 문항은 높게 잡힙니다.
          </li>
          <li>
            <b>처음 보는 문항은 찍기 확률인가요?</b>
            <br />
            아니요. ① 내가 최근 처음 푼 문항 30개의 정답률(기록이 없을 때만 25%) ② 기출을 익힐수록 남은 여지의 최대 {pct(TRANSFER)}가 더 오름(시험 효과의 전이 —
            메타분석 Pan & Rickard 2018) ③ 변형 문항은 원래 기출 성적의 {Math.round(VARIANT_TRANSFER * 100)}%를 반영합니다.
          </li>
          <li>
            <b>시간을 아무리 늘려도 점수가 더 안 오르는 이유는?</b>
            <br />
            기출 몫은 거의 다 채워도, 처음 보는 문항 몫({pct(sh.fresh)})은 시간을 늘린다고 바로 오르지 않기 때문입니다. 공부하며 처음 보는 문제 정답률이 실제로 오르면(앱이 매일
            다시 잼) 예상과 최고 점수가 함께 오릅니다. 기출 회차를 더 넣으면 기출 몫도 커집니다.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>한계</h3>
        <ul className="plain">
          <li>합격을 보장하는 숫자가 아니라 모형의 어림입니다.</li>
          <li>가상 학습자 시험에서 예상 오차는 대개 ±4점, 아주 빨리 잊는 경우 약 8점 높게 예상됐습니다.</li>
        </ul>
      </div>
    </section>
  );
}
