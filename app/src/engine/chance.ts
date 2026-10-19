/**
 * 합격 가능성(ADR 014). 예상 점수를 "합격할 확률"로 바꾼다.
 *
 * 1. 시험 문항 운: 실력이 같아도 과목당 20문항 시험은 점수가 흔들린다 → 과목마다 정답 수 ~ 이항(20, 점수/100)으로 보고
 *    "모든 과목 ≥ 과락선 그리고 평균 ≥ 합격선"의 확률을 정확히 계산(passProbability)
 * 2. 예상 자체의 오차: 가상 학습자 시험(게이트)에서 시험 전날 예상 평균이 실제와 ±5점 안이었다. 예상이 전 과목 함께
 *    위·아래로 틀릴 수 있다고 보고, 표준편차 MODEL_SD점의 정규분포로 평균한다(passChance)
 */
/**
 * 실제 시험(과목당 n문항)에서 합격할 확률. 과목마다 정답 수 ~ 이항(n, 점수/100), 과목끼리 독립으로 보고
 * "모든 과목 ≥ 과락선 그리고 전체 ≥ 평균 합격선"의 확률을 정확히 계산한다(정답 수 분포의 합성곱).
 * 게이트 조건 2의 비교 척도(ADR 007): 평균 점수는 과락을 감수하고 강한 과목만 올려도 높아지기 때문
 */
export function passProbability(scores: number[], n = 20, subjectMin = 40, avgMin = 60): number {
  const minC = Math.ceil((subjectMin / 100) * n - 1e-9);
  let dist = [1]; // 지금까지 과목의 정답 수 합 분포(모든 과목이 과락선 이상인 경우만)
  for (const sc of scores) {
    const p = Math.min(1, Math.max(0, sc / 100));
    const b: number[] = [];
    let c = Math.pow(1 - p, n); // C(n,0) p^0 (1-p)^n
    for (let k = 0; k <= n; k++) {
      if (k > 0) c = p >= 1 ? (k === n ? 1 : 0) : (c * (n - k + 1) * p) / (k * (1 - p));
      b.push(k >= minC ? c : 0);
    }
    if (p >= 1) b.fill(0), (b[n] = 1);
    const next = new Array(dist.length + n).fill(0);
    for (let i = 0; i < dist.length; i++) if (dist[i]) for (let k = 0; k <= n; k++) next[i + k] += dist[i] * b[k];
    dist = next;
  }
  const need = Math.ceil((avgMin / 100) * n * scores.length - 1e-9);
  return dist.slice(need).reduce((a, x) => a + x, 0);
}


/** 예상 점수의 오차(점, 표준편차) — 게이트 조건 3(±5점)에 맞춘 값 */
export const MODEL_SD = 4;

export function passChance(scores: number[], rule: { subjectMin: number; avgMin: number } = { subjectMin: 40, avgMin: 60 }, n = 20, sd = MODEL_SD): number {
  if (!scores.length) return 0;
  // −2σ…+2σ 다섯 점(가중 = 정규분포 밀도)
  const zs = [-2, -1, 0, 1, 2];
  const ws = zs.map((z) => Math.exp((-z * z) / 2));
  const tot = ws.reduce((a, b) => a + b, 0);
  let p = 0;
  zs.forEach((z, i) => {
    p += (ws[i] / tot) * passProbability(scores.map((x) => Math.max(0, Math.min(100, x + z * sd))), n, rule.subjectMin, rule.avgMin);
  });
  return p;
}
