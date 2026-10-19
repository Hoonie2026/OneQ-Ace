import type { Coach } from '../coach';
import { examScoreMix, TRANSFER } from '../engine/exam';
import { MIN_CALIBRATION_OBS } from '../engine/memory';
import { LATE_DAYS } from '../engine/outlook';
import { VARIANT_TRANSFER } from '../engine/similar';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * 시험일 예상 점수 계산 보기(ADR 014, v0.8.1 실기기 의견 W1·W4 반영).
 * ① 시험 문항 구성 ② 예상점수 산정근거(두 숫자 ⓐ·ⓑ의 뜻 → 과목별 표 + 평균 줄(= 홈 점수) → 계산 예) ③ "지금 → 시험일" 계산 방법 · 가정과 한계.
 * 학습계획 바꾸기·학습 원리는 홈에서만(접근 경로 일원화) — 여기에는 단추를 두지 않는다
 */
export function ForecastView(props: { coach: Coach }) {
  const { coach } = props;
  const { exam, subjects, outlook, ctx } = coach;
  const sh = exam.shares;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const curveObs = ctx.mem.curve.obs;
  const rows = subjects.filter((s) => s.examProjected != null && s.bankProjected != null && s.rateProjected != null);
  const ex = [...rows].sort((a, b) => a.examProjected! - b.examProjected!)[0];
  const questions = subjects.reduce((t, s) => t + s.questions, 0);

  return (
    <section className="stack forecast" data-testid="forecast-view">
      <div className="card">
        <h2>시험일 예상 {exam.projectedAvg ?? '—'}점</h2>
        <p className="hint">
          지금까지의 풀이 기록으로, 학습계획대로 공부한다고 볼 때 실제 시험에서 받을 점수의 어림입니다. 과목별 예상 점수의 <b>평균</b>이 홈에 보이는 점수입니다(② 표 맨 아래 줄).
        </p>
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
        <h3>② 예상점수 산정근거</h3>
        <p>과목마다 두 숫자로 계산합니다.</p>
        <ul className="plain">
          <li>
            <b>ⓐ 기출 점수</b> — 가지고 있는 기출 {questions ? `${questions.toLocaleString()}문항` : ''}을 그날 모두 다시 푼다면 맞힐 비율(100점 만점).
            <br />
            <small className="muted">
              왼쪽 = 오늘까지 공부한 것만으로 시험을 본다면(더 공부하지 않고, 안 푼 문항은 ⓑ만큼) → 오른쪽 = 학습계획대로 남은 기간 공부하고, 그사이 잊는 것까지 계산한 시험일 값
            </small>
          </li>
          <li>
            <b>ⓑ 처음 보는 문항 정답률</b> — 한 번도 안 본 문항을 맞히는 비율.
            <br />
            <small className="muted">왼쪽 = 최근 처음 푼 문항의 정답률(모름은 찍어서 25%) → 오른쪽 = 계획대로 기출을 익히면서 실력이 붙어 조금 오른 값</small>
          </li>
          <li>
            <b>시험 예상</b> = 같은 문항({pct(sh.same)})은 ⓐ만큼, 처음 보는 문항({pct(sh.fresh)})은 ⓑ만큼, 변형({pct(sh.variant)})은 ⓑ와 ⓐ 사이(ⓐ 쪽으로{' '}
            {Math.round(VARIANT_TRANSFER * 100)}%)만큼 맞힌다고 보고 더한 값
          </li>
        </ul>
        <table className="mini-table calc-table" data-testid="forecast-table">
          <thead>
            <tr>
              <th>과목</th>
              <th>
                ⓐ 기출 점수
                <small>지금 멈추면 → 계획대로</small>
              </th>
              <th>
                ⓑ 처음 보는 문항
                <small>지금 멈추면 → 계획대로</small>
              </th>
              <th>
                시험 예상
                <small>계획대로</small>
              </th>
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
            {rows.length === subjects.length && rows.length > 0 && (
              <tr className="avg-row" data-testid="forecast-avg">
                <td>평균(홈 점수)</td>
                <td>
                  {r1(mean(rows.map((s) => s.bankNow)))} → {r1(mean(rows.map((s) => s.bankProjected!)))}
                </td>
                <td>
                  {pct(mean(rows.map((s) => s.newRate.exam)))} → {pct(mean(rows.map((s) => s.rateProjected!)))}
                </td>
                <td>{exam.projectedAvg}</td>
              </tr>
            )}
          </tbody>
        </table>
        {ex && (
          <p className="calc-example" data-testid="forecast-example">
            계산 예 — {ex.name}: ⓐ {r1(ex.bankProjected!)}점, ⓑ {pct(ex.rateProjected!)}
            <br />
            {pct(sh.same)} × {r1(ex.bankProjected!)} + {pct(sh.variant)} × ({r1(100 * ex.rateProjected!)} + {VARIANT_TRANSFER} × ({r1(ex.bankProjected!)} − {r1(100 * ex.rateProjected!)})) +{' '}
            {pct(sh.fresh)} × {r1(100 * ex.rateProjected!)} ≈ <b>{examScoreMix(ex.bankProjected!, { ...ex.newRate, exam: ex.rateProjected! }, sh)}점</b>
          </p>
        )}
        <p className="hint">과목 점수가 {rule.subjectMin}점 미만이면 빨간색(과락 위험)입니다.</p>
      </div>

      <div className="card">
        <h3>③ "계획대로" 값은 어떻게 계산하나</h3>
        <ul className="plain">
          <li>
            <b>ⓐ 기출 점수</b>: 푼 문항마다 FSRS(간격 반복 알고리즘)로 시험일 아침의 기억률을 계산합니다. 맞힐 확률 = 기억률 + (1 − 기억률) × ⓑ(잊어도 찍거나 추론해 맞힐 수
            있음). 안 푼 문항은 ⓑ만큼.
          </li>
          <li>
            남은 학습시간{outlook ? `(학습계획 기준 약 ${Math.round(outlook.plannedMinutes / 60)}시간)` : ''}으로 더 익힐 문항을 예상이 가장 낮은 과목부터 채워 넣고, 시험 직전{' '}
            {LATE_DAYS}일은 이미 익힌 문항의 총정리 복습에 쓴다고 봅니다.
          </li>
          <li>
            <b>ⓑ 처음 보는 문항 정답률</b>: 기출을 새로 익히는 만큼 남은 여지(100% − 지금 정답률)의 최대 {pct(TRANSFER)}가 오른다고 봅니다(학습의 전이).
          </li>
          <li>
            내 망각 속도: {curveObs >= MIN_CALIBRATION_OBS ? `복습 풀이 ${curveObs}건으로 보정한 개인 망각 곡선` : `복습 풀이가 ${MIN_CALIBRATION_OBS}건 쌓일 때까지는 평균적인 학습자 곡선(지금 ${curveObs}건)`}.
            오래 안 본 문항은 보수적으로(더 잊는 쪽으로) 잡습니다.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>가정과 한계</h3>
        <ul className="plain">
          <li>합격을 보장하는 숫자가 아닙니다. 공부한 대로 기억이 유지된다는 모형의 어림입니다.</li>
          <li>
            변형 문항 효과({VARIANT_TRANSFER})·전이({pct(TRANSFER)})는 연구와 측정에 기댄 <b>가정값</b>입니다. 쓰면서 쌓이는 내 기록으로 계속 다시 계산됩니다.
          </li>
          <li>가상 학습자 시험에서 예상과 실제의 차이는 대개 ±4점 안이었고, 아주 빨리 잊는 학습자는 약 8점 높게 예상됐습니다.</li>
          <li>앞으로의 시험 출제 방식이 지금까지의 기출과 다르면 예상이 빗나갈 수 있습니다. 모의고사 성적은 예상 점수 계산에 넣지 않습니다.</li>
        </ul>
      </div>
    </section>
  );
}
