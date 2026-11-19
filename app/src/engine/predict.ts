/**
 * 보유 기출 기준 예상 점수와 위험 판정(개발기준서 6.3).
 *
 * P_s = 100/N_s × Σ_i p_i(T). N_s는 과목의 보유 문항 수(동일 문항도 출제된 횟수만큼 센다).
 * - 학습한 문항: p = r(T) + (1 − r(T)) × prior_s. r(T)는 시험일 기억 확률(FSRS + 긴 공백 보수 보정 — memory.examRecall, ADR 014).
 *   잊어도 미학습 문항만큼은 맞힌다고 본다(그렇지 않으면 푼 뒤 잊은 문항이 처음 보는 문항보다 낮게 계산됨 — ADR 006).
 * - 미학습 문항: prior_s = 그 과목의 첫 풀이 정답률(관측 10건 미만이면 0.25).
 */
import { parseDate } from './days';
import type { Bank, Item } from './items';
import { examRecall, recallAt, type MemoryState } from './memory';
import { VARIANT_TRANSFER, type Concepts } from './similar';
import type { PassRule } from './types';

export type Risk = 'fail-subject' | 'avg-short' | 'safe';

export interface SubjectForecast {
  key: string;
  name: string;
  /** 예상 점수 P_s(0~100, 소수 1자리) */
  score: number;
  risk: Risk;
  /** 보유 문항 수 N_s / 1회 이상 푼 문항 수 / 시험일 기억 확률 0.9 이상 문항 수(7.2 진도율·숙달률) */
  total: number;
  studied: number;
  mastered: number;
}

export interface Forecast {
  subjects: SubjectForecast[];
  /** 전과목 평균 예상 점수 */
  average: number;
  /** 과락 위험이 하나라도 있으면 'fail-subject', 평균이 모자라면 'avg-short' */
  overall: Risk;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** 시험일 T(ms): 시험일 당일 아침 9시(대부분의 시험 시작 시각)로 본다 */
export function examTime(examDate: string): number {
  return parseDate(examDate) + 9 * 3_600_000;
}

/**
 * 문항 하나(학습 단위)의 시험일 정답 확률.
 * 아직 안 푼 문항이라도 같은 개념 군집의 문항을 익혔으면 그만큼 더 맞힌다(변형 문항 — ADR 013):
 * p = prior + VARIANT_TRANSFER × (익힌 군집 문항의 p − prior)
 */
export function itemExamP(item: Item, mem: MemoryState, T: number, conservative = false, concepts?: Concepts): number {
  const prior = (conservative ? mem.priorLow : mem.prior).get(item.subjectKey) ?? 0.25;
  const own = (it: Item) => {
    const m = mem.items.get(it.key);
    if (!m) return null;
    const r = examRecall(m.card, T, mem.curve);
    return r + (1 - r) * prior;
  };
  const p = own(item);
  if (p != null) return p;
  if (!concepts) return prior;
  let best = prior;
  for (const o of concepts.members.get(concepts.clusterOf.get(item.key) ?? '') ?? []) {
    if (o === item) continue;
    const q = own(o);
    if (q != null && q > best) best = q;
  }
  return prior + VARIANT_TRANSFER * (best - prior);
}

/**
 * @param conservative 계획 엔진용: 미학습 문항 정답 확률을 보수적으로(prior − 표준오차). 화면 표시는 기본값(false)
 */
export function forecast(bank: Bank, mem: MemoryState, examDate: string, rule: PassRule, safetyMargin = 10, conservative = false): Forecast {
  const T = examTime(examDate);
  const acc = new Map<string, { sum: number; n: number; studied: number; mastered: number }>();
  for (const it of bank.items) {
    const a = acc.get(it.subjectKey) ?? { sum: 0, n: 0, studied: 0, mastered: 0 };
    const k = it.qids.length;
    a.sum += k * itemExamP(it, mem, T, conservative, bank.concepts);
    a.n += k;
    const m = mem.items.get(it.key);
    if (m) {
      a.studied += k;
      if (recallAt(m.card, T, mem.curve) >= 0.9) a.mastered += k;
    }
    acc.set(it.subjectKey, a);
  }
  const subjects: SubjectForecast[] = bank.subjects
    .filter((s) => s.current && acc.has(s.key))
    .map((s) => {
      const a = acc.get(s.key)!;
      return { key: s.key, name: s.name, score: r1((100 * a.sum) / a.n), risk: 'safe' as Risk, total: a.n, studied: a.studied, mastered: a.mastered };
    });
  const average = subjects.length ? r1(subjects.reduce((t, s) => t + s.score, 0) / subjects.length) : 0;
  const avgShort = average < rule.avgMin + safetyMargin / 2;
  for (const s of subjects) {
    s.risk = s.score < rule.subjectMin + safetyMargin ? 'fail-subject' : avgShort ? 'avg-short' : 'safe';
  }
  const overall: Risk = subjects.some((s) => s.risk === 'fail-subject') ? 'fail-subject' : avgShort ? 'avg-short' : 'safe';
  return { subjects, average, overall };
}
