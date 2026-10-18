/**
 * 오늘 학습 세션 구성(개발기준서 6.5).
 *
 * - 기본 15문항. 슬롯 순서 복습(과락 위험 과목 먼저) → 약점 → 신규, 비율은 주간 계획 구성비를 따른다
 * - 오늘 복습할 것은 예정일이 오늘 이전인 것. 모자라면 신규로 채우고, 그래도 모자라면 이번 주 뒤쪽 복습을 당긴다
 * - 교차 학습: 같은 과목 연속 3문항 이내
 * - 틀린 문항은 세션 끝에 한 번 더(retryTail)
 */
import type { Bank, Item } from './items';
import { dueAt, type MemoryState } from './memory';
import { startOfDay } from './days';
import type { PlannedItem, Slot, WeeklyPlan } from './plan';

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

/**
 * 오늘 낼 수 있는 후보(ADR 011). 오늘 맞힌 문항은 내일부터.
 * - relearn: 오늘 틀린·모름(먼저 틀린 것부터)
 * - wrong: 지난번 틀린·모름이고 복습할 때가 된 것(오래 밀린 것부터)
 * - review: 맞혔지만 복습할 때가 된 것 — FSRS가 맞힌 문항은 간격을 길게(드물게), 헷갈림·오래 걸린 정답은 짧게 잡는다.
 *   찍어서 맞힌 문항도 이렇게 낮은 빈도로 다시 나온다
 * - new: 안 푼 문항(출제빈도 높은 것 → 최근 회차)
 */
function candidates(bank: Bank, mem: MemoryState, subjects: string[], now: number, attempts: StudyAttempt[], exclude: Set<string>): Record<EntryKind, Cand[]> {
  const today = startOfDay(now);
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
    else {
      const d = startOfDay(dueAt(m.card, mem.curve));
      if (d <= today) (m.lastCorrect ? out.review : out.wrong).push({ it, kind: m.lastCorrect ? 'review' : 'wrong', rank: d - it.qids.length });
    }
  }
  for (const k of Object.keys(out) as EntryKind[]) out[k].sort((a, b) => a.rank - b.rank || a.it.key.localeCompare(b.it.key));
  return out;
}

/**
 * 묶음 구성(ADR 011): 복습(오늘 틀린 것 → 지난번 틀린 것 → 맞혔지만 다시 볼 것)은 최대 REVIEW_SHARE까지,
 * 나머지는 새 문항. 틀린 문항이 쌓여도 매일 분량이 복습으로만 차지 않게 하고, 새 문항이 모자라면 복습으로 채운다.
 */
function compose(c: Record<EntryKind, Cand[]>, size: number): SessionEntry[] {
  const reviews = [...c.relearn, ...c.wrong, ...c.review];
  const reviewCap = Math.ceil(size * REVIEW_SHARE);
  const r1 = reviews.slice(0, reviewCap);
  const n1 = c.new.slice(0, size - r1.length);
  const r2 = reviews.slice(reviewCap, reviewCap + (size - r1.length - n1.length));
  const slot = (k: EntryKind): Slot => (k === 'new' ? 'new' : k === 'review' ? 'review' : 'weak');
  return [...r1, ...r2, ...n1].map(({ it, kind }) => ({ qid: representativeQid(it), itemKey: it.key, subjectKey: it.subjectKey, slot: slot(kind), kind }));
}

/** 과목별 학습 세션(ADR 008·011): 그 과목의 전 회차를 하나로 보고 compose 규칙으로 */
export function buildSubjectSession(bank: Bank, mem: MemoryState, subjectKey: string, now: number, attempts: StudyAttempt[], size = SESSION_SIZE, exclude: Set<string> = new Set()): SessionEntry[] {
  return compose(candidates(bank, mem, [subjectKey], now, attempts, exclude), size);
}

/** 과목별로 오늘 낼 수 있는 문항 수(세션 구성과 같은 후보 규칙) */
export function availableCounts(bank: Bank, mem: MemoryState, now: number, attempts: StudyAttempt[]): Map<string, { relearn: number; due: number; fresh: number }> {
  const c = candidates(bank, mem, bank.subjects.map((s) => s.key), now, attempts, new Set());
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
 * 시스템 추천 학습(ADR 010·011): 모든 과목을 대상으로 compose 규칙. 새 문항은 추천 과목(order 맨 앞)부터.
 * @param order 과목 우선순위(추천 과목이 맨 앞). 빠진 과목은 내지 않는다
 */
export function buildDailySession(bank: Bank, mem: MemoryState, order: string[], now: number, attempts: StudyAttempt[], size = SESSION_SIZE): SessionEntry[] {
  return compose(candidates(bank, mem, order, now, attempts, new Set()), size);
}
