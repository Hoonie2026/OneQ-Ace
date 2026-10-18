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
}

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

/**
 * 과목별 학습 세션(ADR 008·009). 그 과목의 전 회차를 하나로 보고 "자동" 순서로 낸다:
 * ⓪ 오늘 틀린 문항 다시(먼저 틀린 것부터) → ① 복습할 때가 된 문항(틀린 것 먼저, 오래 밀린 것 먼저) →
 * ② 출제빈도가 높은 새 문항(같은 빈도면 최근 회차). 오늘 맞힌 문항은 내일부터. 같은 내용은 최근 회차 문항 하나로 낸다.
 */
export function buildSubjectSession(bank: Bank, mem: MemoryState, subjectKey: string, now: number, attempts: StudyAttempt[], size = SESSION_SIZE, exclude: Set<string> = new Set()): SessionEntry[] {
  const today = startOfDay(now);
  const st = todayState(bank, attempts, now);
  const items = bank.items.filter((it) => it.subjectKey === subjectKey && !st.done.has(it.key) && !exclude.has(it.key));
  const relearn: { it: Item; ts: number }[] = [];
  const due: { it: Item; wrong: boolean; due: number }[] = [];
  const fresh: Item[] = [];
  for (const it of items) {
    const m = mem.items.get(it.key);
    const rl = st.relearn.get(it.key);
    if (rl != null) relearn.push({ it, ts: rl });
    else if (!m) fresh.push(it);
    else {
      const d = startOfDay(dueAt(m.card, mem.curve));
      if (d <= today) due.push({ it, wrong: !m.lastCorrect, due: d });
    }
  }
  relearn.sort((a, b) => a.ts - b.ts);
  due.sort((a, b) => Number(b.wrong) - Number(a.wrong) || a.due - b.due || b.it.qids.length - a.it.qids.length);
  fresh.sort((a, b) => b.qids.length - a.qids.length || (bank.examDateOf.get(b.qids[0]) ?? '').localeCompare(bank.examDateOf.get(a.qids[0]) ?? '') || a.key.localeCompare(b.key));
  const picked = [
    ...relearn.map((x) => ({ it: x.it, slot: 'weak' as Slot })),
    ...due.map((x) => ({ it: x.it, slot: (x.wrong ? 'weak' : 'review') as Slot })),
    ...fresh.map((it) => ({ it, slot: 'new' as Slot })),
  ].slice(0, size);
  return picked.map(({ it, slot }) => ({ qid: representativeQid(it), itemKey: it.key, subjectKey: it.subjectKey, slot }));
}

/** 과목별로 오늘 낼 수 있는 문항 수(세션 구성과 같은 규칙 — 카드 숫자와 실제 세션이 어긋나지 않게) */
export function availableCounts(bank: Bank, mem: MemoryState, now: number, attempts: StudyAttempt[]): Map<string, { relearn: number; due: number; fresh: number }> {
  const today = startOfDay(now);
  const st = todayState(bank, attempts, now);
  const out = new Map<string, { relearn: number; due: number; fresh: number }>();
  for (const it of bank.items) {
    if (st.done.has(it.key)) continue;
    const c = out.get(it.subjectKey) ?? { relearn: 0, due: 0, fresh: 0 };
    const m = mem.items.get(it.key);
    if (st.relearn.has(it.key)) c.relearn++;
    else if (!m) c.fresh++;
    else if (startOfDay(dueAt(m.card, mem.curve)) <= today) c.due++;
    out.set(it.subjectKey, c);
  }
  return out;
}

/**
 * 오늘 학습(ADR 009 — 홈의 유일한 입구). 오늘 틀린 문항(모든 과목) 다시 → 추천 과목 세션 → 모자라면 다음 순위 과목.
 * @param order 과목 우선순위(추천 과목이 맨 앞)
 */
export function buildDailySession(bank: Bank, mem: MemoryState, order: string[], now: number, attempts: StudyAttempt[], size = SESSION_SIZE): SessionEntry[] {
  const out: SessionEntry[] = [];
  const used = new Set<string>();
  // ⓪ 오늘 틀린 문항(모든 과목) 먼저
  const st = todayState(bank, attempts, now);
  for (const [key] of [...st.relearn].sort((a, b) => a[1] - b[1])) {
    if (out.length >= size) break;
    const it = bank.items.find((x) => x.key === key);
    if (!it || !order.includes(it.subjectKey)) continue;
    out.push({ qid: representativeQid(it), itemKey: it.key, subjectKey: it.subjectKey, slot: 'weak' });
    used.add(key);
  }
  for (const sk of order) {
    if (out.length >= size) break;
    for (const e of buildSubjectSession(bank, mem, sk, now, attempts, size - out.length, used)) {
      out.push(e);
      used.add(e.itemKey);
    }
  }
  return out;
}
