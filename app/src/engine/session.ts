/**
 * 오늘 학습 세션 구성(개발기준서 6.5).
 *
 * - 기본 15문항. 슬롯 순서 복습(과락 위험 과목 먼저) → 약점 → 신규, 비율은 주간 계획 구성비를 따른다
 * - 오늘 복습할 것은 예정일이 오늘 이전인 것. 모자라면 신규로 채우고, 그래도 모자라면 이번 주 뒤쪽 복습을 당긴다
 * - 교차 학습: 같은 과목 연속 3문항 이내
 * - 틀린 문항은 세션 끝에 한 번 더(retryTail)
 */
import type { Item } from './items';
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
