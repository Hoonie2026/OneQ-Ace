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

/**
 * 과목별 학습 세션(ADR 008 — 핵심 학습). 그 과목의 전 회차를 하나로 보고 "자동" 순서로 낸다:
 * ① 복습할 때가 된 문항(틀린 것 먼저, 오래 밀린 것 먼저) → ② 출제빈도가 높은 새 문항(같은 빈도면 최근 회차).
 * 오늘 이미 푼 문항은 빼고(같은 날 다시 푸는 것은 "틀린 문항 다시"가 맡음), 같은 내용은 최근 회차 문항 하나로 낸다.
 */
export function buildSubjectSession(bank: Bank, mem: MemoryState, subjectKey: string, now: number, attempts: { qid: string; ts: number }[], size = SESSION_SIZE): SessionEntry[] {
  const today = startOfDay(now);
  const doneToday = new Set(attempts.filter((a) => a.ts >= today).map((a) => bank.itemOf.get(a.qid)?.key).filter(Boolean));
  const items = bank.items.filter((it) => it.subjectKey === subjectKey && !doneToday.has(it.key));
  const due: { it: Item; wrong: boolean; due: number }[] = [];
  const fresh: Item[] = [];
  for (const it of items) {
    const m = mem.items.get(it.key);
    if (!m) fresh.push(it);
    else {
      const d = startOfDay(dueAt(m.card, mem.curve));
      if (d <= today) due.push({ it, wrong: !m.lastCorrect, due: d });
    }
  }
  due.sort((a, b) => Number(b.wrong) - Number(a.wrong) || a.due - b.due || b.it.qids.length - a.it.qids.length);
  fresh.sort((a, b) => b.qids.length - a.qids.length || (bank.examDateOf.get(b.qids[0]) ?? '').localeCompare(bank.examDateOf.get(a.qids[0]) ?? '') || a.key.localeCompare(b.key));
  const picked = [...due.map((x) => ({ it: x.it, slot: (x.wrong ? 'weak' : 'review') as Slot })), ...fresh.map((it) => ({ it, slot: 'new' as Slot }))].slice(0, size);
  return picked.map(({ it, slot }) => ({ qid: representativeQid(it), itemKey: it.key, subjectKey: it.subjectKey, slot }));
}

/** 과목별 복습할 때가 된 문항 수(오늘 기준) */
export function dueCounts(bank: Bank, mem: MemoryState, now: number): Map<string, number> {
  const today = startOfDay(now);
  const out = new Map<string, number>();
  for (const it of bank.items) {
    const m = mem.items.get(it.key);
    if (m && startOfDay(dueAt(m.card, mem.curve)) <= today) out.set(it.subjectKey, (out.get(it.subjectKey) ?? 0) + 1);
  }
  return out;
}
