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

/** 실제 시험 기준 점수: ρ × 보유 기출 기준 + (1 − ρ) × 처음 보는 문항 정답률(시험 기준) */
export function examScore(bankScore: number, rate: NewRate, rho: number): number {
  return Math.round((rho * bankScore + (1 - rho) * 100 * rate.exam) * 10) / 10;
}
