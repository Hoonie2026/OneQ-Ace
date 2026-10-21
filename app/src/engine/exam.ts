/**
 * 실제 시험 기준 점수(ADR 008). 실기기 v0.2.0에서 "보유 기출 기준" 예상이 1회차 100문항만 있을 때 85점(합격권)으로 나와
 * 과장이 드러났다 — 실제 시험은 대부분 처음 보는 문항이다.
 *
 * 시험 점수 = 같은 기출 몫 × 보유 기출 기준 점수 + 변형 몫 × (…) + 신규 몫 × 처음 보는 문항 정답률 — examScoreMix(ADR 013).
 *   (ADR 008의 첫 식 ρ × 기출 + (1 − ρ) × 신규는 ADR 013에서 같은·변형·신규 세 몫으로 바뀌어 v0.9.1에서 코드 삭제)
 * - 처음 보는 문항 정답률 = 과목별 **최근** 첫 풀이의 정답률(공부할수록 오르는 힘을 반영). 시험에서는 모르는 문항도 찍으므로
 *   "모름"은 4지선다 추측 확률(25%)로 센다. 틀린 답은 이미 찍은 것이라 그대로 0
 *
 * 현재 점수(v0.11 — ADR 020)는 따로: 실제로 푼 문항만 분모, 같은 문항은 1번·가장 최근 답으로(모름·오답 0) — solvedScores. "지금까지 결과"
 */
import { GUESS } from './memory';
import type { Bank } from './items';
import { VARIANT_TRANSFER, type ExamShares } from './similar';
import type { EngineAttempt } from './types';

/** 처음 보는 문항 정답률에 쓰는 최근 첫 풀이 수(과목별) */
export const RECENT_FIRST = 30;
const NEW_PSEUDO = 5;

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
  // 모름은 시험에선 찍으므로 25%. 웹검색은 v0.9.2부터 답한 뒤에만 열려 "검색 후 맞힘" 보정이 필요 없다
  const examOf = (a: EngineAttempt) => (a.correct ? 1 : a.chosen === 0 ? GUESS : 0);
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

/** 현재 점수 한 과목(또는 전체): 푼 문항 수 · 그중 최근 답이 정답인 문항 수 · 점수(푼 문항이 없으면 null) */
export interface SolvedScore {
  solved: number;
  correct: number;
  score: number | null;
}

/**
 * 현재 점수(v0.11 — ADR 020, 사용자 결정): **실제로 푼 문항 중 정답 비율**.
 * - 분모 = 한 번이라도 푼 문항(보유 문항 전체가 아님). 같은 문항(다른 회차의 같은 내용 포함 — 학습 단위)은 여러 번 풀어도 1문항
 * - 정답/오답은 그 문항의 **가장 최근 답**으로(회독 수는 반영하지 않음). 모름은 오답, [쉬움]은 정답
 * - 모의고사 풀이는 원장에서 이미 빠져 있다(load.ts — 모의고사 성적은 모의고사 이력에만)
 * 반환: 과목 key → 점수, 그리고 '*' = 모든 과목 합계(홈의 현재 점수)
 */
export function solvedScores(bank: Bank, attempts: EngineAttempt[]): Map<string, SolvedScore> {
  const last = new Map<string, EngineAttempt>();
  for (const a of attempts) {
    const it = bank.itemOf.get(a.qid);
    if (!it) continue;
    const cur = last.get(it.key);
    if (!cur || a.ts >= cur.ts) last.set(it.key, a);
  }
  const acc = new Map<string, { solved: number; correct: number }>();
  const add = (k: string, ok: boolean) => {
    const v = acc.get(k) ?? { solved: 0, correct: 0 };
    v.solved++;
    if (ok) v.correct++;
    acc.set(k, v);
  };
  const current = new Set(bank.subjects.filter((s) => s.current).map((s) => s.key));
  for (const it of bank.items) {
    const l = last.get(it.key);
    if (!l) continue;
    add(it.subjectKey, l.correct);
    if (current.has(it.subjectKey)) add('*', l.correct);
  }
  const out = new Map<string, SolvedScore>();
  for (const k of [...bank.subjects.map((s) => s.key), '*']) {
    const v = acc.get(k) ?? { solved: 0, correct: 0 };
    out.set(k, { ...v, score: v.solved ? Math.round((1000 * v.correct) / v.solved) / 10 : null });
  }
  return out;
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
