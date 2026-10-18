/**
 * 풀이 원장 → 학습 단위별 FSRS 기억 상태(개발기준서 6.2, D4 ts-fsrs).
 *
 * 카드는 원장에서 매번 다시 계산한다(attempts가 원장, cards는 파생값 — 4.2). 수천 건 재생은 수 ms라
 * 저장해 둘 이유가 아직 없고, 등급 규칙을 바꿔도 기록이 그대로 새 규칙을 따른다. 캐시는 7단계 실측 후 판단.
 *
 * 등급(6.2): 오답·모름 → Again, 정답이지만 헷갈림 또는 과목 중앙값의 1.5배 이상 걸림 → Hard, 정답 → Good.
 * Easy는 쓰지 않는다. 목표 기억률 0.90. 같은 날 여러 번 푼 기록은 첫 풀이만 반영한다
 * (FSRS 장기 기억 모델은 하루 단위. 세션 끝 재출제는 기억 강화가 아니라 오류 교정이다).
 *
 * **망각 곡선 보정(ADR 006)**: FSRS 기본 매개변수는 평균적인 학습자 기준이고, 망각 곡선의 꼬리가 길다
 * (안정도 0.2일짜리도 14일 뒤 52%). 복습 풀이가 30건 이상 쌓이면 "예측 기억 확률 vs 실제 정답"이 가장 잘 맞는
 * 안정도 배율 k(0.1~4)와 곡선 감쇠 d(FSRS 기본 ~0.15 ~ 3)를 격자 탐색으로 찾아 예상 점수·복습 예정일에 쓴다.
 * 빨리 잊는 사람은 k < 1 또는 d가 커져 복습이 앞당겨지고 예상 점수가 낮아진다. (FSRS 매개변수 최적화의 가벼운 대체)
 */
import { createEmptyCard, fsrs, forgetting_curve, Rating, type Card, type Grade } from 'ts-fsrs';
import { DAY_MS, startOfDay } from './days';
import type { Bank } from './items';
import type { EngineAttempt } from './types';

export const TARGET_RETENTION = 0.9;
/** 4지선다 추측 확률. 관측이 부족한 과목의 미학습 문항 정답 확률 */
export const GUESS = 0.25;
/** 과목 진단: 과목마다 첫 풀이가 이만큼 쌓일 때까지 그 과목 신규 문항을 먼저 낸다(ADR 006) */
export const MIN_OBS = 15;
/** 첫 풀이 정답률을 전체 평균 쪽으로 당기는 가상 관측 수 */
export const PRIOR_PSEUDO = 10;
/** 계획용 보수적 추정에서 빼는 표준오차 배수 */
export const LOW_Z = 1;
/** 문항당 소요시간 초기값(6.4) */
export const DEFAULT_SEC_PER_Q = 90;
/** 계획용 문항당 시간의 범위(초)와, 실측으로 바꾸기 전에 필요한 풀이 수.
 * 실기기 v0.2.0: "모름"을 빠르게 연달아 누른 기록(0.15초)이 중앙값이 되어 하루 2시간 = 47,368문항으로 계산됐다(5a P2) */
export const SEC_PER_Q_MIN = 30;
export const SEC_PER_Q_MAX = 300;
export const MIN_TIMING_OBS = 20;
/** 이보다 빨리 답한 풀이는 시간 실측에서 뺀다(읽지 않고 누른 것) */
export const MIN_ELAPSED_MS = 5_000;

export const scheduler = fsrs({
  request_retention: TARGET_RETENTION,
  enable_fuzz: false,
  // 분 단위 학습 단계는 쓰지 않는다: 계획은 일 단위, 같은 날 재출제는 세션 구성이 맡는다
  enable_short_term: false,
});

export interface ItemMemory {
  card: Card;
  /** 처음 푼 날(현지 자정) */
  firstTs: number;
  lastTs: number;
  /** 마지막 풀이 결과(모름은 false) */
  lastCorrect: boolean;
  /** 오답·모름 이력이 있는가(6.4 c_i 가산) */
  everWrong: boolean;
  attempts: number;
}

export interface MemoryState {
  items: Map<string, ItemMemory>; // item.key → 기억
  /** 과목별 미학습 문항 정답 확률(첫 풀이 정답률을 전체 평균 쪽으로 당긴 값). 관측이 없으면 GUESS */
  prior: Map<string, number>;
  /** 계획용 보수적 추정(prior − 표준오차). 관측이 적어 운 좋게 높게 잡힌 과목이 계속 소외되지 않게(ADR 006) */
  priorLow: Map<string, number>;
  priorObs: Map<string, number>;
  /** 문항당 소요시간 실측 중앙값(초). 관측이 없으면 DEFAULT_SEC_PER_Q */
  secPerQuestion: number;
  /** 개인 망각 곡선(복습 풀이 30건 미만이면 FSRS 기본값) */
  curve: Curve;
}

export interface Curve {
  /** 안정도 배율 k */
  scale: number;
  /** 곡선 감쇠 d(클수록 오래 지나면 더 많이 잊음) */
  decay: number;
  /** 근거가 된 복습 풀이 수 */
  obs: number;
}

export const MIN_CALIBRATION_OBS = 30;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function gradeOf(a: EngineAttempt, subjectMedianMs: number | null): Grade {
  if (!a.correct) return Rating.Again;
  if (a.unsure) return Rating.Hard;
  if (subjectMedianMs != null && a.elapsedMs >= subjectMedianMs * 1.5) return Rating.Hard;
  return Rating.Good;
}

/** 원장 전체를 시간순으로 재생해 학습 단위별 카드를 만든다 */
export function replay(bank: Bank, attempts: EngineAttempt[]): MemoryState {
  const rows = attempts.filter((a) => bank.itemOf.has(a.qid)).sort((a, b) => a.ts - b.ts);

  // 과목별 풀이 시간 중앙값(이상치 영향이 적게 중앙값, 10분 초과는 자리 비움으로 보고 제외)
  const times = new Map<string, number[]>();
  for (const a of rows) {
    // 모름·5초 미만(읽지 않고 누름)·10분 초과(자리 비움)는 풀이 시간으로 보지 않는다
    if (a.chosen === 0 || a.elapsedMs < MIN_ELAPSED_MS || a.elapsedMs > 600_000) continue;
    const sk = bank.itemOf.get(a.qid)!.subjectKey;
    (times.get(sk) ?? times.set(sk, []).get(sk)!).push(a.elapsedMs);
  }
  const subjMedian = new Map([...times].map(([k, v]) => [k, median(v)]));
  const all = [...times.values()].flat();

  const items = new Map<string, ItemMemory>();
  const firstCorrect = new Map<string, { n: number; c: number }>();
  const reviews: { S: number; days: number; correct: boolean; subjectKey: string }[] = [];
  for (const a of rows) {
    const item = bank.itemOf.get(a.qid)!;
    const day = startOfDay(a.ts);
    let m = items.get(item.key);
    if (m && startOfDay(m.lastTs) === day) {
      // 같은 날 다시 푼 것은 카드에 반영하지 않되, 이력에는 남긴다
      m.attempts++;
      m.everWrong ||= !a.correct;
      continue;
    }
    if (!m) {
      const f = firstCorrect.get(item.subjectKey) ?? { n: 0, c: 0 };
      f.n++;
      if (a.correct) f.c++;
      firstCorrect.set(item.subjectKey, f);
      m = { card: createEmptyCard(new Date(a.ts)), firstTs: day, lastTs: a.ts, lastCorrect: a.correct, everWrong: false, attempts: 0 };
      items.set(item.key, m);
    } else if (m.card.stability > 0) {
      reviews.push({ S: m.card.stability, days: (a.ts - m.lastTs) / DAY_MS, correct: a.correct, subjectKey: item.subjectKey });
    }
    m.card = scheduler.next(m.card, new Date(a.ts), gradeOf(a, subjMedian.get(item.subjectKey) ?? null)).card;
    m.lastTs = a.ts;
    m.lastCorrect = a.correct;
    m.everWrong ||= !a.correct;
    m.attempts++;
  }
  // 미학습 문항 정답 확률(6.3): 과목별 첫 풀이 정답률. 관측이 적은 과목은 흔들림이 커서(10건이면 ±15%p)
  // 전체 첫 풀이 정답률 쪽으로 당긴다(경험적 베이즈, 가상 관측 PRIOR_PSEUDO건). 전체는 0.25 쪽으로 당긴다
  // (기준서 6.3의 "10건 미만이면 0.25"를 연속적으로 바꾼 것 — ADR 006)
  const prior = new Map<string, number>();
  const priorLow = new Map<string, number>();
  const priorObs = new Map<string, number>();
  let n = 0;
  let c = 0;
  for (const f of firstCorrect.values()) {
    n += f.n;
    c += f.c;
  }
  const pooled = (c + PRIOR_PSEUDO * GUESS) / (n + PRIOR_PSEUDO);
  for (const s of bank.subjects) {
    const f = firstCorrect.get(s.key) ?? { n: 0, c: 0 };
    priorObs.set(s.key, f.n);
    const p = (f.c + PRIOR_PSEUDO * pooled) / (f.n + PRIOR_PSEUDO);
    prior.set(s.key, p);
    priorLow.set(s.key, Math.max(GUESS, p - LOW_Z * Math.sqrt((p * (1 - p)) / (f.n + PRIOR_PSEUDO))));
  }
  const med = median(all);
  return {
    items,
    prior,
    priorLow,
    priorObs,
    secPerQuestion: med != null && all.length >= MIN_TIMING_OBS ? Math.min(SEC_PER_Q_MAX, Math.max(SEC_PER_Q_MIN, med / 1000)) : DEFAULT_SEC_PER_Q,
    curve: fitCurve(reviews, prior),
  };
}

/** FSRS-6 기본 감쇠(w20) */
export const DEFAULT_DECAY: number = scheduler.parameters.w[20] ?? 0.1542;
export const DEFAULT_CURVE: Curve = { scale: 1, decay: DEFAULT_DECAY, obs: 0 };

/** FSRS 멱함수 망각 곡선. R(S) = 0.9가 되도록 정규화돼 있어 감쇠를 바꿔도 안정도의 뜻(90% 유지 기간)은 같다 */
export function curveR(days: number, stability: number, c: Curve): number {
  return forgetting_curve(c.decay, days, stability * c.scale);
}

type Review = { S: number; days: number; correct: boolean; subjectKey: string };

/** 복습 풀이의 정답 여부에 가장 잘 맞는 (k, d) — 로그 손실 최소, 격자 탐색 */
export function fitCurve(reviews: Review[], prior: Map<string, number>): Curve {
  if (reviews.length < MIN_CALIBRATION_OBS) return { ...DEFAULT_CURVE, obs: reviews.length };
  const decays = [DEFAULT_DECAY, 0.25, 0.4, 0.6, 0.9, 1.3, 2, 3];
  let best: Curve = { ...DEFAULT_CURVE, obs: reviews.length };
  let bestLoss = Infinity;
  for (const decay of decays) {
    for (let i = 0; i <= 30; i++) {
      const scale = Math.exp(Math.log(0.1) + (Math.log(4) - Math.log(0.1)) * (i / 30));
      let loss = 0;
      for (const r of reviews) {
        const R = forgetting_curve(decay, r.days, r.S * scale);
        const pr = prior.get(r.subjectKey) ?? GUESS;
        const p = Math.min(0.999, Math.max(0.001, R + (1 - R) * pr));
        loss -= Math.log(r.correct ? p : 1 - p);
      }
      if (loss < bestLoss - 1e-9) {
        bestLoss = loss;
        best = { scale, decay, obs: reviews.length };
      }
    }
  }
  return best;
}

/** 시각 t(ms)의 기억 확률(개인 망각 곡선 적용). 아직 안 본 카드는 0 */
export function recallAt(card: Card, t: number, curve: Curve = DEFAULT_CURVE): number {
  if (!card.last_review || card.stability <= 0) return 0;
  const elapsed = Math.max(0, (t - card.last_review.getTime()) / DAY_MS);
  return curveR(elapsed, card.stability, curve);
}

/** 복습 예정일: FSRS 간격에 안정도 배율을 곱한다(간격은 안정도에 비례) */
export function dueAt(card: Card, curve: Curve = DEFAULT_CURVE): number {
  if (!card.last_review) return card.due.getTime();
  const last = card.last_review.getTime();
  return last + (card.due.getTime() - last) * curve.scale;
}

/** 한 번 더 풀었을 때(정답 확률 p) 시각 T의 기대 기억 확률 — 6.4의 r_after */
export function recallAfterReview(card: Card | null, reviewAt: number, T: number, p: number, curve: Curve = DEFAULT_CURVE): number {
  const base: Card = card ?? createEmptyCard<Card>(new Date(reviewAt));
  const good = scheduler.next(base, new Date(reviewAt), Rating.Good).card;
  const again = scheduler.next(base, new Date(reviewAt), Rating.Again).card;
  return p * recallAt(good, T, curve) + (1 - p) * recallAt(again, T, curve);
}
