import { fmtMinutes, type Coach } from '../coach';
import { MODEL_SD } from '../engine/chance';
import { TRANSFER } from '../engine/exam';
import { MIN_CALIBRATION_OBS } from '../engine/memory';
import { LATE_DAYS } from '../engine/outlook';
import { VARIANT_TRANSFER } from '../engine/similar';
import { pctText, PACE_DAYS, type Insight } from '../insight';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * 시험일 예상 점수 계산 보기(ADR 014 — 사용자 요청: 예상 점수가 어떻게 나왔는지 내 숫자로).
 * 홈의 "계산 보기"로 연다. 계산 순서대로 ① 시험 문항 구성 ② 과목별 ③ 기출 점수의 시험일 값 ④ 합격 가능성 ⑤ 실제 학습량, 그리고 가정·한계
 */
export function ForecastView(props: { coach: Coach; insight: Insight | null; onPlan: () => void; onPrinciples: () => void }) {
  const { coach, insight } = props;
  const { exam, subjects, outlook, ctx } = coach;
  const sh = exam.shares;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const curveObs = ctx.mem.curve.obs;
  const plan = insight?.plan ?? null;
  return (
    <section className="stack forecast" data-testid="forecast-view">
      <div className="card">
        <h2>
          시험일 예상 {exam.projectedAvg ?? '—'}점{plan && exam.status !== 'unknown' ? ` · 합격 가능성 ${pctText(plan.chance)}` : ''}
        </h2>
        <p className="hint">지금까지의 풀이 기록으로, 학습계획대로 공부한다고 볼 때 실제 시험(과목당 20문항)에서 받을 점수의 어림입니다.</p>
        {exam.status === 'unknown' && <p className="hint">아직 과목마다 처음 푼 문항이 10개가 안 돼 실력 진단 중입니다 — 숫자가 크게 바뀔 수 있습니다.</p>}
      </div>

      <div className="card">
        <h3>① 실제 시험 문항은 어디서 나오나</h3>
        <div className="share-bar" aria-hidden="true">
          <span className="s-same" style={{ width: pct(sh.same) }} />
          <span className="s-var" style={{ width: pct(sh.variant) }} />
          <span className="s-fresh" style={{ width: pct(sh.fresh) }} />
        </div>
        <ul className="legend">
          <li>
            <i className="s-same" /> 보유 기출과 같은 문항 <b>{pct(sh.same)}</b>
          </li>
          <li>
            <i className="s-var" /> 숫자·표현만 바꾼 변형 <b>{pct(sh.variant)}</b>
          </li>
          <li>
            <i className="s-fresh" /> 처음 보는 문항 <b>{pct(sh.fresh)}</b>
          </li>
        </ul>
        <p className="hint">
          보유 기출 {exam.rounds}회차 기준. 측량 기출 34회차를 서로 대조해 잰 값(앞 회차를 30회차 갖고 있으면 같은 문항 약 43%·변형 약 24%)에, 지금 넣은 문제팩끼리 대조한 결과를
          더했습니다. 회차를 많이 넣을수록 기출 몫이 커집니다.
        </p>
      </div>

      <div className="card">
        <h3>② 과목별 계산</h3>
        <table className="mini-table calc-table" data-testid="forecast-table">
          <thead>
            <tr>
              <th>과목</th>
              <th>기출 점수</th>
              <th>처음 보는 문항 정답률</th>
              <th>시험 예상</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((s) => (
              <tr key={s.key}>
                <td>{s.name}</td>
                <td>
                  {r1(s.bankNow)} → <b>{s.bankProjected != null ? r1(s.bankProjected) : '—'}</b>
                </td>
                <td>
                  {pct(s.newRate.exam)} → <b>{s.rateProjected != null ? pct(s.rateProjected) : '—'}</b>
                </td>
                <td className={s.examProjected != null && s.examProjected < rule.subjectMin ? 'bad' : ''}>
                  <b>{s.examProjected ?? '—'}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="formula">
          시험 예상 = 같은 문항 {pct(sh.same)} × 기출 점수 + 변형 {pct(sh.variant)} × (정답률 + {VARIANT_TRANSFER} × (기출 점수 − 정답률)) + 처음 보는 문항 {pct(sh.fresh)} × 정답률
        </p>
        <p className="hint">
          "지금 → 시험일". 기출 점수는 보유 기출 전체를 시험일에 다시 풀면 맞힐 비율, 처음 보는 문항 정답률은 최근 처음 푼 문항의 정답률(모름은 찍어서 25%로)입니다.
        </p>
      </div>

      <div className="card">
        <h3>③ 기출 점수의 시험일 값</h3>
        <ul className="plain">
          <li>
            푼 문항: 문항마다 FSRS로 <b>시험일 아침의 기억률</b>을 계산하고, 맞힐 확률 = 기억률 + (1 − 기억률) × 처음 보는 문항 정답률(잊어도 찍거나 추론해 맞힐 수 있음).
          </li>
          <li>
            남은 학습시간{outlook ? `(${Math.round(outlook.plannedMinutes / 6) / 10}시간)` : ''}: 시험일 예상이 가장 낮은 과목부터 익힐 문항을 채워 넣고, 시험 직전 {LATE_DAYS}일은
            총정리 복습에 쓴다고 봅니다.
          </li>
          <li>
            처음 보는 문항 정답률도 기출을 많이 익힐수록 오른다고 봅니다(전이 — 남은 여지의 최대 {pct(TRANSFER)}).
          </li>
          <li>
            내 망각 속도: {curveObs >= MIN_CALIBRATION_OBS ? `복습 풀이 ${curveObs}건으로 보정한 개인 망각 곡선` : `복습 풀이가 ${MIN_CALIBRATION_OBS}건 쌓일 때까지는 평균적인 학습자 곡선(지금 ${curveObs}건)`}.
            오래 안 본 문항은 두 망각 모형(멱함수·지수) 사이로 보수적으로 잡습니다.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>④ 합격 가능성</h3>
        <p>
          과목마다 20문항을 푸는 실제 시험에서 <b>모든 과목 {rule.subjectMin}점 이상 + 평균 {rule.avgMin}점 이상</b>일 확률입니다.
        </p>
        <ul className="plain">
          <li>시험 운: 실력이 같아도 20문항 시험의 과목 점수는 ±11점쯤 흔들립니다(이항분포로 정확히 계산).</li>
          <li>예상의 오차: 예상 점수 자체도 ±{MODEL_SD}점(표준편차)쯤 틀릴 수 있다고 보고 함께 넣었습니다(가상 학습자 시험의 예상 오차).</li>
        </ul>
        {plan && exam.status !== 'unknown' && (
          <table className="mini-table" data-testid="forecast-chance">
            <tbody>
              <tr>
                <td>계획대로 하면</td>
                <td>
                  {plan.avg}점 · <b>{pctText(plan.chance)}</b>
                </td>
              </tr>
              {insight?.atPace && (
                <tr>
                  <td>최근 학습량 그대로면</td>
                  <td>
                    {insight.atPace.avg}점 · <b>{pctText(insight.atPace.chance)}</b>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>⑤ 계획과 실제 학습량</h3>
        {insight?.pace ? (
          <p>
            최근 {insight.pace.days}일(어제까지, 최대 {PACE_DAYS}일) 실제 풀이 시간은 하루 평균 <b>{fmtMinutes(insight.pace.minutesPerDay)}</b>, 같은 기간 계획은{' '}
            {fmtMinutes(insight.pace.plannedPerDay)}입니다({Math.round(insight.pace.ratio * 100)}%). 쉬는 날도 포함한 평균이고, 문항당 최대 5분까지만 셉니다(모의고사 시간 제외).
            {insight.atPace ? ' 실제가 계획보다 적어, 남은 기간도 같은 비율로 공부한다고 보고 따로 계산했습니다(④).' : ' 계획대로 진행 중입니다.'}
          </p>
        ) : (
          <p className="hint">기록이 3일 이상 쌓이면 실제 학습량(하루 평균 풀이 시간)과 계획을 비교해 보여 줍니다.</p>
        )}
        {insight && (insight.need.safe != null || insight.need.min != null) && (
          <p data-testid="forecast-need">
            여유 있게 합격(과목 {rule.subjectMin + (coach.settings?.safetyMargin ?? 10) / 2}점·평균 {rule.avgMin + (coach.settings?.safetyMargin ?? 10) / 2}점 이상 예상)하려면 평소 하루{' '}
            <b>{insight.need.safe != null ? fmtMinutes(insight.need.safe) : '8시간 넘게'}</b>
            {insight.need.min != null && <>, 합격선에 딱 닿으려면 하루 {fmtMinutes(insight.need.min)}</>}. 날짜별로 정한 날도 같은 비율로 늘려 계산합니다.
          </p>
        )}
        <button className="btn btn-block" onClick={props.onPlan}>
          학습계획 설정 및 재설정 ›
        </button>
      </div>

      <div className="card">
        <h3>가정과 한계</h3>
        <ul className="plain">
          <li>합격을 보장하는 숫자가 아닙니다. 공부한 대로 기억이 유지된다는 모형의 어림입니다.</li>
          <li>
            변형 문항 효과({VARIANT_TRANSFER})·전이({pct(TRANSFER)})는 연구와 측정에 기댄 <b>가정값</b>입니다. 쓰면서 쌓이는 내 기록으로 계속 다시 계산됩니다.
          </li>
          <li>앞으로의 시험 출제 방식이 지금까지의 기출과 다르면 예상이 빗나갈 수 있습니다.</li>
          <li>모의고사 성적은 실제 시험과 같은 방식의 점검용이라 예상 점수 계산에는 넣지 않습니다.</li>
        </ul>
        <button className="link-btn" onClick={props.onPrinciples}>
          학습 원리와 근거 자세히 ›
        </button>
      </div>
    </section>
  );
}
