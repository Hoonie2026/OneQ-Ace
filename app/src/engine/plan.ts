/**
 * 주간 계획 엔진(개발기준서 6.4). 앱을 열 때마다 다시 계산한다.
 *
 * 1. 가용량 C = 하루 학습시간 × 이번 주 남은 학습일 ÷ 문항당 소요시간(실측 중앙값, 없으면 1.5분)
 * 2. 필수 복습 R = 이번 주 안에 복습 예정인 학습 단위(시험일을 넘는 간격은 시험 전 주로 당김)
 * 3. 신규 U = 미학습 단위 ÷ max(1, 남은 주 − 1) × 이번 주 남은 비율. 마지막 주는 0
 *    — 단 과락 위험 과목은 마지막 주에도 신규를 허용(시뮬레이션: 14일 시나리오에서 과락이 남음 — ADR 006)
 * 4. R + U ≤ C 이면 복습 전부 + 신규 U개, 넘치면 기대 점수 이득 Δ가 큰 순서로 C개
 *    고를 때마다 과목 예상 점수를 갱신해 w_s를 다시 정한다(한 과목만 몰아 고르지 않게 — ADR 006)
 *    Δ_i = w_s · c_i · k_i · (100/N_s) · (p_after(T) − p_before(T))
 *    w_s: 과락 위험 3 / 평균 부족 시 개선 여지가 큰 과목 2 / 그 외 1
 *    c_i: 유사 군집 크기 가중 1 + 0.5(군집 크기 − 1) × 오답·모름 이력 1.5
 *    k_i: 동일 문항 수(출제빈도) — 한 번 풀면 같은 문항 모두에 적용되므로
 */
import { addDays, daysBetween, formatDate, parseDate, startOfDay } from './days';
import type { Bank, Item } from './items';
import { dueAt, MIN_OBS, recallAfterReview, recallAt, type MemoryState } from './memory';
import { examTime, forecast, type Forecast } from './predict';
import type { EngineAttempt, PlanSettings } from './types';

export type Slot = 'review' | 'weak' | 'new';

/** 복습이 넘칠 때도 먼저 보장하는 복습 몫(가용량 대비) */
export const REVIEW_FLOOR = 0.3;

export interface PlannedItem {
  item: Item;
  slot: Slot;
  /** 기대 점수 이득(평균 점수 기준이 아니라 과목 점수 기준, 점) */
  gain: number;
  /** 복습 예정일(현지 자정). 신규는 오늘 */
  due: number;
}

export interface Shortage {
  /** 지금 시간으로 시험일까지 남는 미학습 문항(학습 단위) 수 */
  unlearnedLeft: number;
  /** 하루 몇 분을 늘리면 해소되는가 */
  extraMinutesPerDay: number;
}

export interface WeeklyPlan {
  today: string;
  weekStart: string;
  weekEnd: string;
  daysLeft: number; // 시험일까지 남은 날(오늘 포함하지 않음)
  weeksLeft: number; // 이번 주 포함
  finalWeek: boolean;
  /** 이번 주 남은 학습일·가용량(문항) */
  studyDaysLeft: number;
  capacity: number;
  secPerQuestion: number;
  /** 이번 주에 이미 푼 학습 단위 수 */
  doneThisWeek: number;
  /** 남은 이번 주 목표(이득 큰 순) */
  items: PlannedItem[];
  counts: Record<Slot, number>;
  /** 이번 주 목표 = 이미 푼 것 + 남은 목표 */
  weeklyGoal: number;
  /** 하루 권장량 = 남은 목표 ÷ 남은 학습일 */
  dailyTarget: number;
  shortage: Shortage | null;
  forecast: Forecast;
}

/** 이번 주 월요일 */
export function weekStartOf(ts: number): number {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7; // 월=0
  return addDays(d.getTime(), -dow);
}

/** 과목 가중치 w_s(6.4): 과락 위험 3 / 평균 부족 시 개선 여지가 평균 이상인 과목 2 / 그 외 1 */
function subjectWeights(scores: Map<string, number>, rule: PlanSettings['passRule'], m: number): Map<string, number> {
  const vals = [...scores.values()];
  const avg = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  const avgShort = avg < rule.avgMin + m / 2;
  const meanRoom = 100 - avg;
  const w = new Map<string, number>();
  for (const [k, sc] of scores) w.set(k, sc < rule.subjectMin + m ? 3 : avgShort && 100 - sc >= meanRoom ? 2 : 1);
  return w;
}

export interface PlanInput {
  bank: Bank;
  mem: MemoryState;
  attempts: EngineAttempt[];
  settings: PlanSettings;
  now: number;
}

export function planWeek({ bank, mem, attempts, settings, now }: PlanInput): WeeklyPlan {
  const today = startOfDay(now);
  const examDay = parseDate(settings.examDate);
  const T = examTime(settings.examDate);
  const daysLeft = Math.max(0, daysBetween(today, examDay));
  const ws = weekStartOf(today);
  const we = addDays(ws, 6);
  const lastStudyDay = Math.min(we, addDays(examDay, -1));
  const calDaysLeft = Math.max(0, daysBetween(today, lastStudyDay) + 1); // 오늘 포함
  const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));
  const finalWeek = daysLeft <= 7;
  const perDay = settings.dailyMinutes * 60 / mem.secPerQuestion;
  const ratio = Math.min(1, settings.studyDaysPerWeek / 7);
  const studyDaysLeft = calDaysLeft === 0 ? 0 : Math.max(1, Math.round(calDaysLeft * ratio));
  const capacity = Math.floor(perDay * studyDaysLeft);

  const fc = forecast(bank, mem, settings.examDate, settings.passRule, settings.safetyMargin);
  // 고르는 데는 보수적 예상 점수를 쓴다(관측이 적은 과목을 과대평가해 소외시키지 않게)
  const fcLow = forecast(bank, mem, settings.examDate, settings.passRule, settings.safetyMargin, true);
  const current = new Set(fc.subjects.map((x) => x.key));
  const riskySubj = new Set(fcLow.subjects.filter((x) => x.risk === 'fail-subject').map((x) => x.key));
  const nS = bank.questionCount;
  const k = mem.curve;
  const clusterSize = new Map<string, number>();
  for (const it of bank.items) if (it.clusterId) clusterSize.set(it.clusterId, (clusterSize.get(it.clusterId) ?? 0) + 1);

  const doneThisWeek = new Set(attempts.filter((a) => a.ts >= ws && bank.itemOf.has(a.qid)).map((a) => bank.itemOf.get(a.qid)!.key)).size;
  const doneToday = new Set(attempts.filter((a) => a.ts >= today && bank.itemOf.has(a.qid)).map((a) => bank.itemOf.get(a.qid)!.key));
  const finalWeekStart = addDays(examDay, -7);

  /** w_s를 곱하기 전 이득과, 과목 점수 상승분(점) */
  const baseGain = (it: Item, reviewAt: number): { gain: number; lift: number } => {
    const prior = mem.priorLow.get(it.subjectKey) ?? 0.25;
    const m = mem.items.get(it.key);
    const rNow = m ? recallAt(m.card, reviewAt, k) : 0;
    const pNow = m ? rNow + (1 - rNow) * prior : prior;
    const rT = m ? recallAt(m.card, T, k) : 0;
    const before = m ? rT + (1 - rT) * prior : prior;
    const rAfter = recallAfterReview(m?.card ?? null, reviewAt, T, pNow, k);
    const after = rAfter + (1 - rAfter) * prior;
    const lift = it.qids.length * (100 / (nS.get(it.subjectKey) ?? 1)) * (after - before);
    const c = (1 + 0.5 * ((it.clusterId ? clusterSize.get(it.clusterId) ?? 1 : 1) - 1)) * (m?.everWrong ? 1.5 : 1);
    return { gain: c * lift, lift };
  };

  type Cand = PlannedItem & { base: number; lift: number };
  const review: Cand[] = [];
  const fresh: Cand[] = [];
  let studied = 0;
  for (const it of bank.items) {
    if (!current.has(it.subjectKey)) continue; // 현행 과목만
    if (doneToday.has(it.key)) continue; // 오늘 이미 푼 것은 내일부터
    const m = mem.items.get(it.key);
    if (!m) {
      if (!finalWeek || riskySubj.has(it.subjectKey)) {
        const g = baseGain(it, today);
        fresh.push({ item: it, slot: 'new', gain: 0, due: today, base: g.gain, lift: g.lift });
      }
      continue;
    }
    studied++;
    let due = startOfDay(dueAt(m.card, k));
    // 시험일을 넘는 간격은 시험 전 주로 당긴다(마지막 주에 아직 안 본 문항만)
    if (due >= examDay && m.lastTs < finalWeekStart) due = Math.max(finalWeekStart, today);
    if (due > lastStudyDay) continue;
    const at = Math.max(due, today);
    const g = baseGain(it, at);
    review.push({ item: it, slot: m.lastCorrect ? 'review' : 'weak', gain: 0, due: at, base: g.gain, lift: g.lift });
  }
  const unlearned = bank.items.filter((it) => current.has(it.subjectKey) && !mem.items.has(it.key)).length;
  const U = finalWeek
    ? fresh.length
    : Math.ceil((unlearned / Math.max(1, weeksLeft - 1)) * Math.min(1, calDaysLeft / 7));

  // 과목 점수를 갱신하며 고르는 탐욕 선택: 매번 (w_s × 이득)이 가장 큰 후보, 같으면 점수가 낮은 과목
  const scores = new Map(fcLow.subjects.map((x) => [x.key, x.score]));
  const pick = (cands: Cand[], n: number): Cand[] => {
    const bySubj = new Map<string, Cand[]>();
    for (const c of cands) (bySubj.get(c.item.subjectKey) ?? bySubj.set(c.item.subjectKey, []).get(c.item.subjectKey)!).push(c);
    for (const l of bySubj.values()) l.sort((a, b) => b.base - a.base || a.item.key.localeCompare(b.item.key));
    const pos = new Map([...bySubj.keys()].map((s) => [s, 0]));
    const out: Cand[] = [];
    while (out.length < n) {
      const w = subjectWeights(scores, settings.passRule, settings.safetyMargin);
      let best: Cand | null = null;
      for (const [s, l] of bySubj) {
        const c = l[pos.get(s)!];
        if (!c) continue;
        c.gain = (w.get(s) ?? 1) * c.base;
        if (!best || c.gain > best.gain || (c.gain === best.gain && (scores.get(s) ?? 0) < (scores.get(best.item.subjectKey) ?? 0))) best = c;
      }
      if (!best) break;
      pos.set(best.item.subjectKey, pos.get(best.item.subjectKey)! + 1);
      scores.set(best.item.subjectKey, (scores.get(best.item.subjectKey) ?? 0) + best.lift);
      out.push(best);
    }
    return out;
  };
  // 과목 진단: 첫 풀이가 MIN_OBS건 안 된 과목은 그만큼 신규를 먼저 낸다(실력을 모르면 배분이 틀린다 — ADR 006)
  // 과목을 번갈아 고르고, 복습을 밀어내지 않게 가용량의 절반까지만
  const diag: Cand[] = [];
  if (!finalWeek) {
    const queues = [...current]
      .map((sk) => fresh.filter((c) => c.item.subjectKey === sk).slice(0, Math.max(0, MIN_OBS - (mem.priorObs.get(sk) ?? 0))))
      .filter((q) => q.length);
    const cap = Math.floor(capacity / 2);
    for (let i = 0; diag.length < cap && queues.some((q) => i < q.length); i++) {
      for (const q of queues) if (i < q.length && diag.length < cap) diag.push(q[i]);
    }
    for (const c of diag) c.gain = Number.MAX_SAFE_INTEGER; // 맨 앞
  }
  const diagSet = new Set(diag);
  const restFresh = fresh.filter((c) => !diagSet.has(c));
  const room = Math.max(0, capacity - diag.length);
  let chosen: Cand[];
  if (review.length + Math.max(0, U - diag.length) <= room) {
    const w = subjectWeights(scores, settings.passRule, settings.safetyMargin);
    for (const r of review) {
      r.gain = (w.get(r.item.subjectKey) ?? 1) * r.base;
      scores.set(r.item.subjectKey, (scores.get(r.item.subjectKey) ?? 0) + r.lift);
    }
    chosen = [...diag, ...review, ...pick(restFresh, Math.max(0, U - diag.length))];
  } else {
    // 필수 복습(6.4)은 넘쳐도 가용량의 REVIEW_FLOOR만큼은 먼저 보장한다. Δ만으로 고르면 기억 모델이 아직
    // 보정되지 않은 초반에 복습이 전부 밀려 보정할 자료도 생기지 않는다(시뮬레이션 — ADR 006)
    const floor = Math.min(review.length, Math.ceil(room * REVIEW_FLOOR));
    const must = pick(review, floor);
    const mustSet = new Set(must);
    chosen = [...diag, ...must, ...pick([...review.filter((r) => !mustSet.has(r)), ...restFresh], room - must.length)];
  }
  const items: PlannedItem[] = chosen.map(({ item, slot, gain, due }) => ({ item, slot, gain, due }));
  const counts = { review: 0, weak: 0, new: 0 } as Record<Slot, number>;
  for (const p of items) counts[p.slot]++;

  // 부족 경고: 남은 학습일 전체 가용량으로 미학습 단위를 다 볼 수 있는가
  // 신규 1개 ≈ 처음 + 중간 복습 + 마지막 주 복습 3회, 학습한 단위 ≈ 마지막 주 복습 1회로 어림한다
  const totalStudyDays = Math.max(0, Math.round(daysLeft * ratio));
  const totalCap = perDay * totalStudyDays;
  const need = unlearned * 3 + studied;
  let shortage: Shortage | null = null;
  if (unlearned > 0 && need > totalCap) {
    const lack = need - totalCap;
    shortage = {
      unlearnedLeft: Math.min(unlearned, Math.ceil(lack / 3)),
      extraMinutesPerDay: totalStudyDays > 0 ? Math.ceil((lack * mem.secPerQuestion) / 60 / totalStudyDays) : Infinity,
    };
  }

  return {
    today: formatDate(today),
    weekStart: formatDate(ws),
    weekEnd: formatDate(we),
    daysLeft,
    weeksLeft,
    finalWeek,
    studyDaysLeft,
    capacity,
    secPerQuestion: mem.secPerQuestion,
    doneThisWeek,
    items,
    counts,
    weeklyGoal: doneThisWeek + items.length,
    dailyTarget: studyDaysLeft ? Math.ceil(items.length / studyDaysLeft) : 0,
    shortage,
    forecast: fc,
  };
}
