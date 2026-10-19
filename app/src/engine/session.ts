/**
 * 학습 묶음 구성. 두 가지가 있다(ADR 014에서 정리).
 *
 * **A. 앱 화면이 쓰는 것 — 시스템 추천(buildDailySession)·과목별(buildSubjectSession)** (ADR 011·014)
 * - 복습(오늘 틀린 것 → 지난번 틀린 것 → 맞혔지만 다시 볼 것, FSRS 예정일 순)은 묶음의 최대 REVIEW_SHARE(60%), 나머지는 새 문항
 * - 새 문항: 진단이 덜 된 과목 번갈아(과목당 DIAG_OBS) → 과목마다 합격 확률 기여도 비례 배분(scores — 없으면 과목 순서대로) → 출제빈도 → 최근 회차
 * - 시험 직전 FINAL_DAYS일: 복습을 시험일 기억률이 낮은 순으로(총정리)
 * - 과목을 일부러 섞지 않는다(교차 학습 효과는 자료에 따라 다르다 — Brunmair & Richter 2019). 다 풀면 틀린 것만 한 번 더(retryTail)
 * - 가상 학습자 게이트는 이 방식을 검증한다(sim.ts policy 'daily')
 *
 * **B. 계획 엔진 세션(buildTodaySession — 개발기준서 6.5, 4단계)**: 주간 계획(Δ 선택)의 슬롯 구성비대로 15문항,
 * 같은 과목 연속 3문항 이내로 섞는다. 화면에서는 쓰지 않고, 게이트의 비교 대상(policy 'engine')으로 남겼다 —
 * 같은 학습시간에서 A가 합격 확률이 더 높았다(ADR 014)
 */
import type { Bank, Item } from './items';
import { dueAt, recallAt, type MemoryState } from './memory';
import { addDays, startOfDay } from './days';
import { subjectWeights, type PlannedItem, type Slot, type WeeklyPlan } from './plan';
import type { PassRule } from './types';

export const SESSION_SIZE = 15;
export const MAX_SAME_SUBJECT_RUN = 3;

export interface SessionEntry {
  qid: string;
  itemKey: string;
  subjectKey: string;
  slot: Slot;
  /** 왜 나왔나(추천 학습 안내용): 오늘 틀린 것 다시 / 지난번 틀린·모름 복습 / 맞혔지만 다시 볼 때 / 새 문항 */
  kind?: EntryKind;
}

export type EntryKind = 'relearn' | 'wrong' | 'review' | 'new';

/** 학습 단위에서 보여 줄 문항: 가장 최근 회차의 것(현행 표현) */
export function representativeQid(item: Item): string {
  return item.qids[0];
}

/** 같은 과목이 MAX_SAME_SUBJECT_RUN을 넘게 이어지지 않도록 순서를 바꾼다(가능한 한 원래 순서 유지) */
export function interleave<T extends { subjectKey: string }>(list: T[], maxRun = MAX_SAME_SUBJECT_RUN): T[] {
  const rest = [...list];
  const out: T[] = [];
  while (rest.length) {
    const tail = out.slice(-maxRun);
    const blocked = tail.length === maxRun && tail.every((x) => x.subjectKey === tail[0].subjectKey) ? tail[0].subjectKey : null;
    const i = blocked == null ? 0 : rest.findIndex((x) => x.subjectKey !== blocked);
    out.push(rest.splice(i < 0 ? 0 : i, 1)[0]); // 다른 과목이 없으면 어쩔 수 없이 이어 붙인다
  }
  return out;
}

export function buildTodaySession(plan: WeeklyPlan, today: number, size = SESSION_SIZE): SessionEntry[] {
  const risky = new Set(plan.forecast.subjects.filter((s) => s.risk === 'fail-subject').map((s) => s.key));
  const dueNow = (p: PlannedItem) => p.due <= today;
  const reviewSort = (a: PlannedItem, b: PlannedItem) =>
    Number(risky.has(b.item.subjectKey)) - Number(risky.has(a.item.subjectKey)) || b.gain - a.gain;
  const pools: Record<Slot, PlannedItem[]> = {
    review: plan.items.filter((p) => p.slot === 'review' && dueNow(p)).sort(reviewSort),
    weak: plan.items.filter((p) => p.slot === 'weak' && dueNow(p)).sort(reviewSort),
    new: plan.items.filter((p) => p.slot === 'new'),
  };
  const later = plan.items.filter((p) => p.slot !== 'new' && !dueNow(p)).sort((a, b) => a.due - b.due || b.gain - a.gain);

  // 주간 구성비대로 슬롯 몫을 나눈다(남은 자리는 다음 슬롯으로 넘김)
  const total = plan.counts.review + plan.counts.weak + plan.counts.new || 1;
  const want: Record<Slot, number> = {
    review: Math.round((size * plan.counts.review) / total),
    weak: Math.round((size * plan.counts.weak) / total),
    new: 0,
  };
  want.new = size - want.review - want.weak;
  const picked: PlannedItem[] = [];
  let carry = 0;
  for (const slot of ['review', 'weak', 'new'] as Slot[]) {
    const take = pools[slot].slice(0, want[slot] + carry);
    picked.push(...take);
    carry = want[slot] + carry - take.length;
    pools[slot] = pools[slot].slice(take.length);
  }
  // 모자라면 남은 오늘 몫 → 이번 주 뒤쪽 복습 순으로 채운다
  for (const extra of [pools.review, pools.weak, pools.new, later]) {
    if (picked.length >= size) break;
    picked.push(...extra.slice(0, size - picked.length));
  }
  const entries = picked.map<SessionEntry>((p) => ({
    qid: representativeQid(p.item),
    itemKey: p.item.key,
    subjectKey: p.item.subjectKey,
    slot: p.slot,
  }));
  return interleave(entries);
}

/** 세션 끝 재출제: 틀리거나 모른 문항을 한 번 더(같은 과목 연속 규칙은 유지) */
export function retryTail(entries: SessionEntry[], wrongQids: Set<string>): SessionEntry[] {
  return interleave(entries.filter((e) => wrongQids.has(e.qid)));
}

/** 세션 구성에 필요한 풀이 기록(모드가 있으면 모의고사를 구분한다) */
export type StudyAttempt = { qid: string; ts: number; correct: boolean; mode?: string };

/**
 * 오늘 학습 상태(학습 단위별): 오늘 정답을 보고 맞힌 것은 "오늘 끝"(내일부터), 오늘 틀린 것은 "다시 익힐 것".
 * 모의고사는 정답을 보여 주지 않으므로 오늘 끝으로 치지 않는다 — 실기기 v0.3.0: 모의고사를 푼 날
 * 모든 문항이 "오늘 이미 푼 문항"이 되어 과목 학습이 비었다(Q3)
 */
export function todayState(bank: Bank, attempts: StudyAttempt[], now: number): { done: Set<string>; relearn: Map<string, number> } {
  const today = startOfDay(now);
  const last = new Map<string, StudyAttempt>();
  for (const a of attempts) {
    if (a.ts < today || a.mode === 'mock') continue;
    const it = bank.itemOf.get(a.qid);
    if (!it) continue;
    const cur = last.get(it.key);
    if (!cur || a.ts > cur.ts) last.set(it.key, a);
  }
  const done = new Set<string>();
  const relearn = new Map<string, number>();
  for (const [k, a] of last) {
    if (a.correct) done.add(k);
    else relearn.set(k, a.ts);
  }
  return { done, relearn };
}

/** 한 묶음에서 복습(다시·틀린·맞힌 것 다시 보기)이 차지할 최대 몫. 나머지는 새 문항(새 문항이 모자라면 복습으로 채움) — ADR 011 */
export const REVIEW_SHARE = 0.6;

interface Cand {
  it: Item;
  kind: EntryKind;
  /** 정렬 키: 작을수록 먼저 */
  rank: number;
}

/** 묶음 구성 옵션(ADR 014) */
export interface ComposeOpts {
  /** 시험일(현지 자정 ms). 있으면 시험 직전 FINAL_DAYS일은 "시험일 총정리" 복습 */
  examDay?: number;
  /** 복습 최대 몫(기본 REVIEW_SHARE — 가상 학습자 시험으로 40·60·80% 비교) */
  reviewShare?: number;
  /** 과목 진단: 첫 풀이가 DIAG_OBS건 안 된 과목들의 새 문항을 번갈아 먼저(기본 켬) */
  diag?: boolean;
  /**
   * 과목별 지금 예상 점수. 주면 새 문항을 한 과목에 몰지 않고 **합격 확률 기여도**(plan.subjectWeights — 과락선에 가까울수록 큼)에
   * 비례해 나눈다(ADR 014). 없으면 과목 순서대로(맨 앞 과목부터 다)
   */
  scores?: Map<string, number>;
  passRule?: PassRule;
}

/** 과목 진단 기준(outlook.OUTLOOK_MIN_OBS와 같은 값): 과목마다 첫 풀이가 이만큼 쌓여야 예상 점수를 낸다 */
export const DIAG_OBS = 10;

/**
 * 시험 직전 며칠(outlook.LATE_DAYS와 같은 값 — 예상 점수 계산이 가정하는 "시험 직전 총정리"를 추천도 그대로 한다).
 * 이 기간 복습은 예정일 대신 **시험일 기억률이 낮은 순**(익힌 문항 전체, 출제빈도 가중)으로 고른다. 복습 몫은 그대로
 */
export const FINAL_DAYS = 3;
/** 총정리 대상: 시험일 기억률이 이보다 낮은 문항 */
export const FINAL_R = 0.95;

/**
 * 오늘 낼 수 있는 후보(ADR 011·014). 오늘 맞힌 문항은 내일부터.
 * - relearn: 오늘 틀린·모름(먼저 틀린 것부터)
 * - wrong: 지난번 틀린·모름이고 복습할 때가 된 것(오래 밀린 것부터)
 * - review: 맞혔지만 복습할 때가 된 것 — FSRS가 맞힌 문항은 간격을 길게(드물게), 헷갈림·오래 걸린 정답은 짧게 잡는다.
 *   찍어서 맞힌 문항도 이렇게 낮은 빈도로 다시 나온다
 *   (시험 직전 FINAL_DAYS일: 예정일과 상관없이 시험일 기억률이 낮은 순)
 * - new: 안 푼 문항(과목 순서 → 출제빈도 높은 것 → 최근 회차). 진단이 덜 된 과목이 있으면 그 과목들을 번갈아 먼저
 */
function candidates(bank: Bank, mem: MemoryState, subjects: string[], now: number, attempts: StudyAttempt[], exclude: Set<string>, opts: ComposeOpts = {}): Record<EntryKind, Cand[]> {
  const today = startOfDay(now);
  const finalOn = opts.examDay != null && today >= addDays(opts.examDay, -FINAL_DAYS) && today < opts.examDay;
  const T = (opts.examDay ?? 0) + 9 * 3_600_000;
  const st = todayState(bank, attempts, now);
  const subjRank = new Map(subjects.map((k, i) => [k, i]));
  const out: Record<EntryKind, Cand[]> = { relearn: [], wrong: [], review: [], new: [] };
  for (const it of bank.items) {
    const sr = subjRank.get(it.subjectKey);
    if (sr == null || st.done.has(it.key) || exclude.has(it.key)) continue;
    const rl = st.relearn.get(it.key);
    const m = mem.items.get(it.key);
    if (rl != null) out.relearn.push({ it, kind: 'relearn', rank: rl });
    else if (!m) out.new.push({ it, kind: 'new', rank: sr * 1e6 - it.qids.length * 1e3 - Number((bank.examDateOf.get(it.qids[0]) ?? '').replace(/-/g, '')) / 1e5 });
    else if (finalOn) {
      const rT = recallAt(m.card, T, mem.curve);
      if (rT < FINAL_R) (m.lastCorrect ? out.review : out.wrong).push({ it, kind: m.lastCorrect ? 'review' : 'wrong', rank: -(1 - rT) * it.qids.length });
    } else {
      const d = startOfDay(dueAt(m.card, mem.curve));
      if (d <= today) (m.lastCorrect ? out.review : out.wrong).push({ it, kind: m.lastCorrect ? 'review' : 'wrong', rank: d - it.qids.length });
    }
  }
  for (const k of Object.keys(out) as EntryKind[]) out[k].sort((a, b) => a.rank - b.rank || a.it.key.localeCompare(b.it.key));
  const head = opts.diag !== false ? diagFirst(out.new, subjects, mem) : [];
  const taken = new Set(head);
  const rest = out.new.filter((c) => !taken.has(c));
  out.new = [...head, ...(opts.scores ? byWeight(rest, subjects, opts.scores, opts.passRule ?? { subjectMin: 40, avgMin: 60 }) : rest)];
  return out;
}

/**
 * 과목 진단(ADR 014): 첫 풀이가 DIAG_OBS건 안 된 과목이 있으면 그 과목들의 새 문항을 모자란 만큼 **번갈아** 맨 앞에.
 * 진단이 끝나야 과목별 예상 점수가 나온다 — 한 과목씩 몰아 풀면 5과목 진단에 5일이 걸렸다
 */
function diagFirst(list: Cand[], subjects: string[], mem: MemoryState): Cand[] {
  const need = new Map(subjects.map((k) => [k, Math.max(0, DIAG_OBS - (mem.priorObs.get(k) ?? 0))]));
  if (![...need.values()].some((v) => v > 0)) return [];
  const queues = subjects.map((k) => list.filter((c) => c.it.subjectKey === k).slice(0, need.get(k)));
  const head: Cand[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) head.push(q[i]);
  return head;
}

/**
 * 새 문항의 과목 배분(ADR 014): 과목마다 합격 확률 기여도 w_s에 비례(동트 방식 — 다음 문항은 w_s / (이미 준 수 + 1)이 가장 큰 과목).
 * 과락선에 가까운 과목이 가장 많이 받지만 다른 과목도 조금씩 — 하루 분량을 한 과목에 다 주면 빨리 잊는 학습자에게서
 * 다른 과목이 무너졌다(가상 학습자 망각형: 75점 과목과 37점 과목)
 */
function byWeight(list: Cand[], subjects: string[], scores: Map<string, number>, rule: PassRule): Cand[] {
  const present = subjects.filter((k) => scores.has(k));
  const w = subjectWeights(new Map(present.map((k) => [k, scores.get(k)!])), rule);
  const queues = new Map(subjects.map((k) => [k, list.filter((c) => c.it.subjectKey === k)]));
  const given = new Map(subjects.map((k) => [k, 0]));
  const out: Cand[] = [];
  for (;;) {
    let best: string | null = null;
    let bestV = -1;
    for (const k of subjects) {
      if (!queues.get(k)!.length) continue;
      const v = (w.get(k) ?? 1e-6) / (given.get(k)! + 1);
      if (v > bestV) {
        bestV = v;
        best = k;
      }
    }
    if (best == null) break;
    out.push(queues.get(best)!.shift()!);
    given.set(best, given.get(best)! + 1);
  }
  return out;
}

/**
 * 묶음 구성(ADR 011): 복습(오늘 틀린 것 → 지난번 틀린 것 → 맞혔지만 다시 볼 것)은 최대 REVIEW_SHARE까지,
 * 나머지는 새 문항. 틀린 문항이 쌓여도 매일 분량이 복습으로만 차지 않게 하고, 새 문항이 모자라면 복습으로 채운다.
 */
function compose(c: Record<EntryKind, Cand[]>, size: number, share: number = REVIEW_SHARE): SessionEntry[] {
  const reviews = [...c.relearn, ...c.wrong, ...c.review];
  const reviewCap = Math.ceil(size * share);
  const r1 = reviews.slice(0, reviewCap);
  const n1 = c.new.slice(0, size - r1.length);
  const r2 = reviews.slice(reviewCap, reviewCap + (size - r1.length - n1.length));
  const slot = (k: EntryKind): Slot => (k === 'new' ? 'new' : k === 'review' ? 'review' : 'weak');
  return [...r1, ...r2, ...n1].map(({ it, kind }) => ({ qid: representativeQid(it), itemKey: it.key, subjectKey: it.subjectKey, slot: slot(kind), kind }));
}

/** 과목별 학습 세션(ADR 008·011): 그 과목의 전 회차를 하나로 보고 compose 규칙으로 */
export function buildSubjectSession(bank: Bank, mem: MemoryState, subjectKey: string, now: number, attempts: StudyAttempt[], size = SESSION_SIZE, exclude: Set<string> = new Set(), opts: ComposeOpts = {}): SessionEntry[] {
  return compose(candidates(bank, mem, [subjectKey], now, attempts, exclude, opts), size, opts.reviewShare);
}

/** 과목별로 오늘 낼 수 있는 문항 수(세션 구성과 같은 후보 규칙) */
export function availableCounts(bank: Bank, mem: MemoryState, now: number, attempts: StudyAttempt[], opts: ComposeOpts = {}): Map<string, { relearn: number; due: number; fresh: number }> {
  const c = candidates(bank, mem, bank.subjects.map((s) => s.key), now, attempts, new Set(), opts);
  const out = new Map<string, { relearn: number; due: number; fresh: number }>();
  const add = (x: Cand, f: 'relearn' | 'due' | 'fresh') => {
    const v = out.get(x.it.subjectKey) ?? { relearn: 0, due: 0, fresh: 0 };
    v[f]++;
    out.set(x.it.subjectKey, v);
  };
  c.relearn.forEach((x) => add(x, 'relearn'));
  [...c.wrong, ...c.review].forEach((x) => add(x, 'due'));
  c.new.forEach((x) => add(x, 'fresh'));
  return out;
}

/**
 * 시스템 추천 학습(ADR 010·011·014): 모든 과목을 대상으로 compose 규칙. 새 문항은 추천 과목(order 맨 앞)부터.
 * @param order 과목 우선순위(추천 과목이 맨 앞). 빠진 과목은 내지 않는다
 * @param opts examDay를 주면 시험 직전 총정리, diag(기본 켬)는 과목 진단
 */
export function buildDailySession(bank: Bank, mem: MemoryState, order: string[], now: number, attempts: StudyAttempt[], size = SESSION_SIZE, opts: ComposeOpts = {}): SessionEntry[] {
  return compose(candidates(bank, mem, order, now, attempts, new Set(), opts), size, opts.reviewShare);
}
