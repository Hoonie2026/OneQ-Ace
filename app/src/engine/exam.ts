/**
 * 실제 시험 기준 점수(ADR 008). 실기기 v0.2.0에서 "보유 기출 기준" 예상이 1회차 100문항만 있을 때 85점(합격권)으로 나와
 * 과장이 드러났다 — 실제 시험은 대부분 처음 보는 문항이다.
 *
 * 시험 점수 ≈ ρ × (보유 기출 기준 점수) + (1 − ρ) × (처음 보는 문항 정답률)
 * - ρ = 반복 출제 비율: 보유 회차에서, 앞선 회차에 같은 문항이 있었던 문항의 비율. 회차가 적으면 측량기사 34회차 실측(약 10%) 쪽으로 당긴다
 * - 처음 보는 문항 정답률 = 과목별 **최근** 첫 풀이의 정답률(공부할수록 오르는 힘을 반영). 시험에서는 모르는 문항도 찍으므로
 *   "모름"은 4지선다 추측 확률(25%)로 센다. 틀린 답은 이미 찍은 것이라 그대로 0
 *
 * 현재 점수(기록 그대로)는 따로: 푼 문항은 가장 최근 답(모름·오답 0점), 안 푼 문항 0점 — 회차 성적(3단계)과 같은 셈법. "지금까지 결과"
 */
import { GUESS } from './memory';
import type { Bank } from './items';
import { VARIANT_TRANSFER, type ExamShares } from './similar';
import type { EngineAttempt } from './types';

/** 반복 출제 비율 기본값(측량및지형공간정보기사 2011~2022 34회차 실측: 3,400문항 중 311문항이 앞 회차와 같은 문항) */
export const DEFAULT_REPEAT_SHARE = 0.1;
/** 기본값 쪽으로 당기는 가상 문항 수(회차가 많을수록 실측을 따른다) */
export const REPEAT_PSEUDO = 500;
/** 처음 보는 문항 정답률에 쓰는 최근 첫 풀이 수(과목별) */
export const RECENT_FIRST = 30;
const NEW_PSEUDO = 5;

export interface RepeatShare {
  rho: number;
  /** 실측: 맨 처음 회차를 뺀 문항 수와 그중 앞 회차에 같은 문항이 있던 수 */
  questions: number;
  repeats: number;
}

export function repeatShare(bank: Bank): RepeatShare {
  const dates = [...new Set(bank.examDateOf.values())].sort();
  let questions = 0;
  let repeats = 0;
  if (dates.length > 1) {
    const first = dates[0];
    for (const it of bank.items) {
      const ds = it.qids.map((q) => bank.examDateOf.get(q) ?? '').sort();
      for (const [i, d] of ds.entries()) {
        if (d === first) continue;
        questions++;
        if (i > 0 && ds[0] < d) repeats++;
      }
    }
  }
  return { rho: (repeats + REPEAT_PSEUDO * DEFAULT_REPEAT_SHARE) / (questions + REPEAT_PSEUDO), questions, repeats };
}

export interface NewRate {
  /** 기록 그대로의 정답률(모름 0) */
  raw: number;
  /** 시험 기준(모름은 찍어서 25%) */
  exam: number;
  /** 근거가 된 최근 첫 풀이 수 */
  n: number;
}

/** 과목별 처음 보는 문항 정답률(최근 RECENT_FIRST개 첫 풀이, 전체 평균 쪽으로 가볍게 당김) */
export function newItemRates(bank: Bank, attempts: EngineAttempt[]): Map<string, NewRate> {
  const firsts = new Map<string, EngineAttempt[]>();
  const seen = new Set<string>();
  for (const a of [...attempts].sort((x, y) => x.ts - y.ts)) {
    const it = bank.itemOf.get(a.qid);
    if (!it || seen.has(it.key)) continue;
    seen.add(it.key);
    (firsts.get(it.subjectKey) ?? firsts.set(it.subjectKey, []).get(it.subjectKey)!).push(a);
  }
  const all = [...firsts.values()].flatMap((l) => l.slice(-RECENT_FIRST));
  const pool = (f: (a: EngineAttempt) => number, base: number) => (all.reduce((t, a) => t + f(a), 0) + NEW_PSEUDO * base) / (all.length + NEW_PSEUDO);
  const rawOf = (a: EngineAttempt) => (a.correct ? 1 : 0);
  // 자신 없이 맞힘(답하기 전 웹검색·헷갈림)은 시험에선 찍은 것으로
  const examOf = (a: EngineAttempt) => (a.correct ? (a.unsure ? GUESS : 1) : a.chosen === 0 ? GUESS : 0);
  const poolRaw = pool(rawOf, GUESS);
  const poolExam = pool(examOf, GUESS);
  const out = new Map<string, NewRate>();
  for (const s of bank.subjects) {
    const l = (firsts.get(s.key) ?? []).slice(-RECENT_FIRST);
    const sum = (f: (a: EngineAttempt) => number) => l.reduce((t, a) => t + f(a), 0);
    out.set(s.key, {
      raw: (sum(rawOf) + NEW_PSEUDO * poolRaw) / (l.length + NEW_PSEUDO),
      exam: (sum(examOf) + NEW_PSEUDO * poolExam) / (l.length + NEW_PSEUDO),
      n: l.length,
    });
  }
  return out;
}

/** 현재 점수(기록 그대로, 안 푼 문항 0점): 과목별, 동일 문항은 출제 횟수만큼 센다 */
export function recordedScores(bank: Bank, attempts: EngineAttempt[]): Map<string, number> {
  const last = new Map<string, EngineAttempt>();
  for (const a of attempts) {
    const it = bank.itemOf.get(a.qid);
    if (!it) continue;
    const cur = last.get(it.key);
    if (!cur || a.ts > cur.ts) last.set(it.key, a);
  }
  const acc = new Map<string, { sum: number; n: number }>();
  for (const it of bank.items) {
    const a = acc.get(it.subjectKey) ?? { sum: 0, n: 0 };
    const l = last.get(it.key);
    const p = l?.correct ? 1 : 0; // 안 푼 문항·모름·오답 0점
    a.sum += p * it.qids.length;
    a.n += it.qids.length;
    acc.set(it.subjectKey, a);
  }
  return new Map([...acc].map(([k, a]) => [k, Math.round((1000 * a.sum) / Math.max(1, a.n)) / 10]));
}

/** 실제 시험 기준 점수(ADR 008 원식 — 동일 문항만 반복 출제로 본 식. 시험·비교용으로 남김) */
export function examScore(bankScore: number, rate: NewRate, rho: number): number {
  return Math.round((rho * bankScore + (1 - rho) * 100 * rate.exam) * 10) / 10;
}

/**
 * 실제 시험 기준 점수(ADR 013): 시험 문항 = 같은 기출(same) + 변형 기출(variant) + 처음 보는 문항(fresh).
 * - 같은 기출: 보유 기출 기준 점수 그대로
 * - 변형: 처음 보는 문항 정답률 r에서, 원 기출을 익힌 만큼 VARIANT_TRANSFER 몫이 올라간다 → r + V × (기출 점수 − r)
 * - 처음 보는 문항: r(공부량에 따른 전이 포함 — projectedRate)
 */
export function examScoreMix(bankScore: number, rate: NewRate, shares: ExamShares): number {
  const r = 100 * rate.exam;
  const v = r + VARIANT_TRANSFER * (bankScore - r);
  return Math.round((shares.same * bankScore + shares.variant * v + shares.fresh * r) * 10) / 10;
}

/** 과목 점수가 subjectMin이 되는 데 필요한 처음 보는 문항 정답률(0~1) */
export function needRateMix(subjectMin: number, bankScore: number, shares: ExamShares): number {
  const k = shares.variant * (1 - VARIANT_TRANSFER) + shares.fresh;
  return Math.max(0, Math.min(1, (subjectMin - (shares.same + shares.variant * VARIANT_TRANSFER) * bankScore) / Math.max(1e-9, 100 * k)));
}

/**
 * 공부량 → 처음 보는 문항 정답률(ADR 011). 실기기 v0.5.0: 학습시간을 늘려도 시험일 예상 점수가 그대로였다 —
 * 처음 보는 문항 정답률을 "지금 값 그대로" 두었기 때문(반복 출제분 ρ≈10%만 공부량에 반응).
 *
 * 기출을 새로 익히면 처음 보는 문항도 더 맞힌다(시험 효과의 전이 — Pan & Rickard 2018 메타분석, 전이 효과 크기 d≈0.40).
 * 보유 기출 중 시험일까지 새로 익힐 비율 Δc만큼, 남은 여지(1 − 지금 정답률)의 TRANSFER를 더한다.
 * 예: 정답률 40%, 남은 기출의 절반(Δc 0.5)을 새로 익히면 40 + 0.3 × 0.5 × 60 = 49%.
 * TRANSFER는 가정값 — 실사용 기록(첫 풀이 정답률이 학습량에 따라 오르는 정도)으로 다시 맞출 것(백로그)
 */
export const TRANSFER = 0.3;
/**
 * 전이는 "익힌 기출의 양"에 달렸다(ADR 013): 보유 기출이 2회차(과목당 10문항)뿐이면 다 외워도 처음 보는 문항이
 * 거의 늘지 않는다. 과목당 학습 단위가 이 수(측량 31회차 ≈ 과목당 560)에 못 미치면 비례해서 줄인다
 */
export const TRANSFER_REF_ITEMS = 500;

export function projectedRate(rate: NewRate, coverageGain: number): NewRate {
  const g = Math.max(0, Math.min(1, coverageGain));
  return { ...rate, exam: rate.exam + TRANSFER * g * (1 - rate.exam), raw: rate.raw + TRANSFER * g * (1 - rate.raw) };
}
