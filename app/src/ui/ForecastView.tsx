import type { Coach } from '../coach';
import { examScoreMix, projectedRate, TRANSFER, TRANSFER_REF_ITEMS } from '../engine/exam';
import { LATE_R } from '../engine/outlook';
import { VARIANT_TRANSFER } from '../engine/similar';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r1 = (x: number) => Math.round(x * 10) / 10;
const f1 = (x: number) => x.toFixed(1);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * 시험일 예상 점수 계산 보기(ADR 014 — v0.8.2 두괄식·개조식, v0.8.3 의견: 출제 유형 그림 복원, 표의 단위를 모두 "점(100점 만점)"으로 통일, 실제 산식).
 * ① 핵심 ② 실제 시험 출제 유형(보유 팩 기준, 막대 그림) ③ 과목별 예상(기출문항·신규문항·시험예상 점수 + 평균) ④ 산식(평균 대입) + 계산 근거(항목별 근거 수준·가정값 오차 범위, v0.8.4) ⑤ 자주 묻는 질문
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

  const aB = rows.length ? mean(rows.map((s) => s.bankProjected!)) : 0;
  const aN = rows.length ? 100 * mean(rows.map((s) => s.rateProjected!)) : 0;
  const per100 = (x: number) => Math.round(x * 100);
  // 가정값 오차(점): ⑤ 계수 ±0.2 → 변형 몫 × (기출 − 신규) × 0.2, ④ 전이 ±15%p(= 지금 가정 30%의 절반) → 신규문항 점수 상승분의 절반이 시험 점수에 미치는 영향
  const aNow = rows.length ? 100 * mean(rows.map((s) => s.newRate.exam)) : 0;
  const errVar = sh.variant * Math.abs(aB - aN) * 0.2;
  const errTr = (sh.fresh + sh.variant * (1 - VARIANT_TRANSFER)) * Math.max(0, aN - aNow) * 0.5;
  const errAssume = Math.max(0.5, Math.round((errVar + errTr) * 2) / 2).toFixed(1);
  const seg = [
    { cls: 's-same', name: '기출과 같은 문항', share: sh.same, note: '기출문항 점수만큼 맞힘' },
    { cls: 's-var', name: '변형 문항', share: sh.variant, note: '숫자·표현만 바꾼 같은 개념' },
    { cls: 's-fresh', name: '신규 문항', share: sh.fresh, note: '보유 기출에 없는 문제' },
  ];

  return (
    <section className="stack forecast" data-testid="forecast-view">
      <div className="card" data-testid="forecast-key">
        <h2>
          시험일 예상 <span className="big-num">{exam.projectedAvg ?? '—'}</span>점
        </h2>
        <ul className="headline">
          <li>학습계획대로 공부했을 때 {subjects.length}과목 예상 점수의 평균입니다.</li>
          <li>기출 몫은 공부할수록 오르고, 신규문항 몫은 내가 처음 보는 문제를 맞히는 실력(지금 {Math.round(100 * nowRate)}점)에 달려 있습니다.</li>
          <li data-testid="forecast-ceiling">
            기출을 모두 익혀 시험날까지 기억해도 지금 실력으로는 <b>약 {ceiling}점</b>이 최고입니다. 신규문항을 더 맞히게 되면 이 선도 함께 오릅니다.
          </li>
        </ul>
        {exam.status === 'unknown' && <p className="hint">과목마다 처음 푼 문항이 10개가 안 돼 진단 중 — 숫자가 크게 바뀔 수 있습니다.</p>}
        {!measured && <p className="hint">아직 풀이 기록이 없어 신규문항 점수를 찍기(25점)로 계산했습니다.</p>}
      </div>

      <div className="card" data-testid="forecast-shares">
        <div className="today-head sub-title">
          <h3>실제 시험은 어디서 나오나</h3>
          <span className="muted">보유 기출 {exam.rounds}회차 기준</span>
        </div>
        <div className="share-bar big" role="img" aria-label={seg.map((x) => `${x.name} ${pct(x.share)}`).join(', ')}>
          {seg.map((x) => (
            <span key={x.cls} className={x.cls} style={{ width: pct(x.share) }}>
              {x.share >= 0.12 ? pct(x.share) : ''}
            </span>
          ))}
        </div>
        <ul className="share-tiles">
          {seg.map((x) => (
            <li key={x.cls}>
              <i className={x.cls} />
              <span>
                <b>{x.name}</b>
                <small>{x.note}</small>
              </span>
              <b className="num">
                {pct(x.share)}
                <small>100문항 중 약 {per100(x.share)}개</small>
              </b>
            </li>
          ))}
        </ul>
        <p className="hint">측량 기출 34회차를 서로 대조해 잰 출제 경향(앞 회차를 많이 가질수록 기출 몫이 커짐)에, 지금 넣은 문제팩끼리 대조한 결과를 더했습니다.</p>
      </div>

      <div className="card">
        <div className="today-head sub-title">
          <h3>과목별 예상점수</h3>
          <span className="muted">계획대로 · 100점 만점</span>
        </div>
        <table className="mini-table calc-table" data-testid="forecast-table">
          <thead>
            <tr>
              <th>과목</th>
              <th className="nowrap">기출문항 점수</th>
              <th className="nowrap">신규문항 점수</th>
              <th className="nowrap">시험예상 점수</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((s) => (
              <tr key={s.key}>
                <td>{s.name}</td>
                <td>{s.bankProjected != null ? f1(s.bankProjected) : '—'}</td>
                <td>{s.rateProjected != null ? f1(100 * s.rateProjected) : '—'}</td>
                <td className={s.examProjected != null && s.examProjected < rule.subjectMin ? 'bad' : ''}>
                  <b>{s.examProjected ?? '—'}</b>
                </td>
              </tr>
            ))}
            {rows.length === subjects.length && rows.length > 0 && (
              <tr className="avg-row" data-testid="forecast-avg">
                <td>평균(홈 점수)</td>
                <td>{f1(aB)}</td>
                <td>{f1(aN)}</td>
                <td>{exam.projectedAvg}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <div className="card" data-testid="forecast-formula">
          <h3>시험예상 점수 산식</h3>
          <p className="formula">
            시험예상 점수 = 기출문항 점수 × {pct(sh.same)}
            <br />+ (신규문항 점수 + {VARIANT_TRANSFER} × (기출문항 점수 − 신규문항 점수)) × {pct(sh.variant)}
            <br />+ 신규문항 점수 × {pct(sh.fresh)}
          </p>
          <p className="calc-example">
            평균 대입: {f1(aB)} × {pct(sh.same)} + ({f1(aN)} + {VARIANT_TRANSFER} × ({f1(aB)} − {f1(aN)})) × {pct(sh.variant)} + {f1(aN)} × {pct(sh.fresh)} ≈{' '}
            <b>{f1(sh.same * aB + sh.variant * (aN + VARIANT_TRANSFER * (aB - aN)) + sh.fresh * aN)}점</b>
          </p>

          <div className="basis" data-testid="forecast-basis">
            <h4>계산 근거</h4>
            <dl>
              <dt>
                ① 산식 구조 <span className="lv ok">확률 계산</span>
              </dt>
              <dd>시험 문항을 출처별(같은·변형·신규)로 나눠, 비율 × 맞힐 확률을 더함(전확률 공식)</dd>

              <dt>
                ② 출제 비율 {pct(sh.same)} · {pct(sh.variant)} · {pct(sh.fresh)} <span className="lv ok">실측</span>
              </dt>
              <dd>측량 기출 34회차를 서로 대조해 측정 + 보유 팩끼리 대조 결과 반영</dd>

              <dt>
                ③ 기출문항 점수 <span className="lv ok">검증된 모형 + 내 기록</span>
              </dt>
              <dd>
                문항마다 맞힐 확률 = 시험일 기억률 + (1 − 기억률) × 신규문항 점수
                <br />
                기억률: FSRS 기억 모형(대규모 실제 학습 기록으로 검증, Anki 내장) · 복습 30건부터 내 망각 속도로 보정
                <br />
                100점이 아님 — 계획대로 익힌 문항은 시험일 기억률 85%, 직전 3일 복습한 문항은 95%로 계산
              </dd>

              <dt>
                ④ 신규문항 점수 <span className="lv ok">내 실측</span>
                <span className="lv warn">+ 가정값</span>
              </dt>
              <dd>
                지금: 최근 처음 푼 문항 30개의 정답률(모름·검색 후 정답 = 찍기 25%, 기록 없으면 25점)
                <br />
                시험일: 기출을 익힐수록 남은 여지의 최대 {pct(TRANSFER)} 상승(전이 — 메타분석 Pan & Rickard 2018 근거, 크기는 가정값)
              </dd>

              <dt>
                ⑤ 변형 문항 계수 {VARIANT_TRANSFER} <span className="lv warn">가정값</span>
              </dt>
              <dd>변형은 신규보다 쉽고 기출보다 어렵다고 보고 둘 사이(기출 쪽 {Math.round(VARIANT_TRANSFER * 100)}%)로 계산</dd>
            </dl>
            <div className="err" data-testid="forecast-error">
              <b>오차 범위</b>
              <ul>
                <li>
                  가정값(④ 전이 {pct(TRANSFER)}±15%p, ⑤ 계수 {VARIANT_TRANSFER}±0.2)으로 인한 오차: <b>±{errAssume}점</b>
                </li>
                <li>
                  모형 전체 검증(가상 학습자 27회): 대개 <b>±4점</b>, 아주 빨리 잊는 학습자는 약 8점 높게 예상
                </li>
                <li>합격을 보장하는 숫자가 아니라 계획대로 공부할 때의 어림값입니다</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>자주 묻는 질문</h3>
        <ul className="plain faq">
          <li>
            <b>몇 회독을 해야 점수에 반영되나요?</b>
            <br />
            회독 수가 아니라 문항마다 맞혔는지·언제 풀었는지로 계산(③). 틀린 문항은 낮게, 간격을 두고 거듭 맞힌 문항은 높게
          </li>
          <li>
            <b>시간을 늘려도 점수가 더 안 오르는 이유는?</b>
            <br />
            기출 몫은 거의 다 채워도 신규문항 몫({pct(sh.fresh)})은 시간만으로 오르지 않음(④). 처음 보는 문제를 실제로 더 맞히면 예상·최고 점수가 함께 오름 · 기출 회차를 더 넣으면
            기출 몫이 커짐
          </li>
        </ul>
      </div>
    </section>
  );
}
