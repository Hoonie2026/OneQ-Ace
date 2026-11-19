/**
 * 예상·경고의 신뢰(ADR 014 — v0.8.0). 홈의 "학습 점검" 카드와 예상 점수 풀이 화면이 쓴다.
 *
 * - 계획대로 하면: 시험일 예상 점수(실제 시험 기준 — coach.examViews). 합격 가능성(%)은 v0.8.1에서 뺐다(사용자 결정 — 복잡함)
 * - 최근 실제 학습량 그대로면: 어제까지 최근 PACE_DAYS일의 실제 풀이 시간으로 남은 계획을 같은 비율로 줄이거나 늘려 다시 계산.
 *   계획을 세워 놓고 그만큼 못 하면 "계획대로 하면" 예상은 너무 낙관적이다 — 실제 속도를 따로 보여 준다
 * - 합격에 필요한 하루 학습시간: 남은 계획(평소 하루 시간·날짜별 시간)을 같은 비율로 키웠을 때 실제 시험 기준 예상이
 *   여유 있게(과목 ≥ 과락선 + 여유/2, 평균 ≥ 합격선 + 여유/2) / 아슬아슬하게(과락선·합격선 그대로) 넘는 가장 작은 시간(이분 탐색)
 *
 * 모두 "모형의 어림"이다 — 합격을 보장하지 않는다. 가정과 한계는 학습 원리 화면에 그대로 적는다.
 */
import { addDays, daysBetween, formatDate, parseDate, startOfDay } from './engine/days';
import { engineForecast, engineOutlook, studyTime, type EngineContext, type PlanSettings } from './engine';
import { examViews, type Coach, type ExamStatus } from './coach';

/** 실제 학습량을 재는 기간(어제까지 최근 며칠) */
export const PACE_DAYS = 14;
/** 이만큼(달력 날) 기록이 쌓여야 실제 학습량을 믿는다 */
export const PACE_MIN_DAYS = 3;
/** 실제 학습량이 계획의 이 비율보다 적으면 "이 속도면" 예상을 따로 계산해 보여 준다 */
export const PACE_BEHIND = 0.9;
/** 문항 하나에 센 풀이 시간의 상한(자리를 비운 시간을 학습시간으로 세지 않게) */
export const ELAPSED_CAP_MS = 5 * 60_000;
/** 필요한 학습시간 탐색 상한(하루 8시간) */
export const MAX_DAILY_MINUTES = 480;

export interface Pace {
  /** 잰 기간(달력 날, 어제까지) */
  days: number;
  /** 그중 실제로 푼 날 */
  activeDays: number;
  /** 하루 평균 실제 풀이 시간(분, 쉬는 날 포함 평균) */
  minutesPerDay: number;
  /** 같은 기간 계획한 하루 평균(분, 쉬는 날 포함 평균) */
  plannedPerDay: number;
  /** 실제 ÷ 계획 */
  ratio: number;
}

export interface Projection {
  avg: number;
  subjects: { key: string; name: string; score: number }[];
  fail: string[];
  status: ExamStatus;
}

export type InsightLevel = 'ok' | 'watch' | 'risk' | 'unknown' | 'no-plan';

export interface Insight {
  level: InsightLevel;
  /** 계획대로 하면 */
  plan: Projection | null;
  /** 최근 실제 학습량 */
  pace: Pace | null;
  /** 최근 속도 그대로면(실제가 계획보다 PACE_BEHIND 미만일 때만) */
  atPace: Projection | null;
  /** 합격에 필요한 평소 하루 학습시간(분): 여유 있게 / 아슬아슬하게. 하루 8시간으로도 어려우면 null */
  need: { safe: number | null; min: number | null };
  /** 지금 계획한 평소 하루 학습시간(분) */
  dailyMinutes: number;
}

/** 최근 실제 학습량(어제까지 최근 PACE_DAYS일, 첫 풀이 날부터). 기록이 PACE_MIN_DAYS일 미만이면 null */
export function recentPace(ctx: EngineContext, now: number): Pace | null {
  if (!ctx.settings || !ctx.attempts.length) return null;
  const today = startOfDay(now);
  const first = startOfDay(Math.min(...ctx.attempts.map((a) => a.ts)));
  const from = Math.max(first, addDays(today, -PACE_DAYS));
  const days = daysBetween(from, today);
  if (days < PACE_MIN_DAYS) return null;
  const fallback = ctx.mem.secPerQuestion * 1000;
  let ms = 0;
  const active = new Set<number>();
  for (const a of ctx.attempts) {
    if (a.ts < from || a.ts >= today) continue;
    ms += Math.min(ELAPSED_CAP_MS, a.elapsedMs > 0 ? a.elapsedMs : fallback);
    active.add(startOfDay(a.ts));
  }
  const planned = studyTime(ctx.settings, from, addDays(today, -1)).minutes / days;
  const minutesPerDay = ms / 60_000 / days;
  return { days, activeDays: active.size, minutesPerDay, plannedPerDay: planned, ratio: planned > 0 ? minutesPerDay / planned : 1 };
}

/** 오늘부터 시험 전날까지 계획 시간을 f배(평소 하루 시간과 날짜별 지정 모두) */
export function scaledSettings(s: PlanSettings, f: number, now: number): PlanSettings {
  const today = formatDate(startOfDay(now));
  const dayMinutes: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.dayMinutes ?? {})) dayMinutes[k] = k >= today ? v * f : v;
  return { ...s, dailyMinutes: s.dailyMinutes * f, dayMinutes };
}

/** 주어진 계획으로 실제 시험 기준 시험일 예상 */
export function projectWith(ctx: EngineContext, settings: PlanSettings, now: number): Projection | null {
  const c2 = { ...ctx, settings };
  const v = examViews(c2, engineForecast(c2), engineOutlook(c2, now), now);
  return toProjection(v.subjects, v.exam.projectedAvg, v.exam.status, settings.passRule);
}

function toProjection(subjects: Coach['subjects'], avg: number | null, status: ExamStatus, rule: PlanSettings['passRule']): Projection | null {
  if (avg == null || subjects.some((s) => s.examProjected == null)) return null;
  const list = subjects.map((s) => ({ key: s.key, name: s.name, score: s.examProjected! }));
  return {
    avg,
    subjects: list,
    fail: list.filter((s) => s.score < rule.subjectMin).map((s) => s.name),
    status,
  };
}

/** 예상이 목표를 넘는가: safe = 과목 ≥ 과락선 + 여유/2, 평균 ≥ 합격선 + 여유/2 / min = 과락선·합격선 그대로 */
function meets(p: Projection | null, s: PlanSettings, kind: 'safe' | 'min'): boolean {
  if (!p) return false;
  const half = kind === 'safe' ? s.safetyMargin / 2 : 0;
  return p.subjects.every((x) => x.score >= s.passRule.subjectMin + half) && p.avg >= s.passRule.avgMin + half;
}

/** 평소 하루 학습시간을 minutes로(날짜별 지정한 날도 같은 비율로) */
export function settingsAtDaily(s: PlanSettings, minutes: number, now: number): PlanSettings {
  const f = s.dailyMinutes > 0 ? minutes / s.dailyMinutes : 1;
  return { ...scaledSettings(s, f, now), dailyMinutes: minutes };
}

/** 합격에 필요한 평소 하루 학습시간(분, 10분 단위). 하루 8시간으로도 안 되면 null. 이분 탐색(예상은 학습시간에 단조 증가) */
export function requiredDaily(ctx: EngineContext, now: number, kind: 'safe' | 'min'): number | null {
  const s = ctx.settings;
  if (!s) return null;
  const ok = (minutes: number) => meets(projectWith(ctx, settingsAtDaily(s, minutes, now), now), s, kind);
  if (!ok(MAX_DAILY_MINUTES)) return null;
  if (ok(10)) return 10;
  let lo = 10; // 못 넘음
  let hi = MAX_DAILY_MINUTES; // 넘음
  while (hi - lo > 10) {
    const mid = Math.round((lo + hi) / 20) * 10;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function computeInsight(coach: Coach, now = Date.now()): Insight {
  const { ctx, settings } = coach;
  const dailyMinutes = settings?.dailyMinutes ?? 0;
  if (!settings) return { level: 'no-plan', plan: null, pace: null, atPace: null, need: { safe: null, min: null }, dailyMinutes };
  const plan = toProjection(coach.subjects, coach.exam.projectedAvg, coach.exam.status, settings.passRule);
  const pace = recentPace(ctx, now);
  const atPace = pace && pace.ratio < PACE_BEHIND ? projectWith(ctx, scaledSettings(settings, Math.max(0, pace.ratio), now), now) : null;
  const daysLeft = Math.max(0, daysBetween(startOfDay(now), parseDate(settings.examDate)));
  const need = daysLeft > 0 ? { safe: requiredDaily(ctx, now, 'safe'), min: requiredDaily(ctx, now, 'min') } : { safe: null, min: null };
  let level: InsightLevel;
  const bad = (p: Projection | null) => !!p && (p.status === 'fail-subject' || p.status === 'avg-short');
  const tight = (p: Projection | null) => !!p && p.status === 'tight';
  if (coach.exam.status === 'unknown') level = 'unknown';
  else if (!plan) level = 'no-plan';
  else if (bad(plan) || bad(atPace)) level = 'risk';
  else if (tight(plan) || tight(atPace)) level = 'watch';
  else level = 'ok';
  return { level, plan, pace, atPace, need, dailyMinutes };
}

