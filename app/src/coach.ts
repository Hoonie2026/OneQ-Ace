/**
 * 홈 대시보드·오늘 학습·모의고사를 학습 엔진에 잇는 곳(5단계). 화면은 엔진을 직접 부르지 않고 이 파일을 쓴다.
 */
import { db as defaultDb, type OneQDB } from './db';
import { addDays, formatDate, parseDate, startOfDay } from './engine/days';
import {
  buildMock,
  buildTodaySession,
  engineForecast,
  engineOutlook,
  enginePlan,
  loadEngine,
  savePlanSettings,
  SESSION_SIZE,
  type EngineContext,
  type Forecast,
  type PassOutlook,
  type PlanSettings,
  type WeeklyPlan,
} from './engine';
import { createSetRun, loadSession, sessionResult, setRuns, type Result, type Target } from './study';

export interface Coach {
  ctx: EngineContext;
  settings: PlanSettings | null;
  plan: WeeklyPlan | null;
  forecast: Forecast | null;
  outlook: PassOutlook | null;
  /** 오늘 푼 문항 수(이 종목, 모든 풀이) */
  doneToday: number;
  /** 끝나지 않은 오늘 학습 묶음(이어서 풀기) */
  openToday: { sessionId: string; left: number; title: string } | null;
}

export async function loadCoach(certCode: string, now = Date.now(), d: OneQDB = defaultDb): Promise<Coach | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx) return null;
  const today = startOfDay(now);
  const doneToday = ctx.attempts.filter((a) => a.ts >= today).length;
  let openToday: Coach['openToday'] = null;
  const open = (await setRuns(certCode, 'today', d)).find((r) => !r.finishedAt);
  if (open) {
    const s = await loadSession({ kind: 'set', sessionId: open.sessionId }, d);
    if (s) openToday = { sessionId: open.sessionId, left: s.qids.filter((q) => !s.answers.has(q)).length, title: open.title };
  }
  return {
    ctx,
    settings: ctx.settings,
    plan: enginePlan(ctx, now),
    forecast: engineForecast(ctx),
    outlook: engineOutlook(ctx, now),
    doneToday,
    openToday,
  };
}

const md = (ts: number) => new Date(ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

/** 오늘 학습 한 세션(15문항)을 만든다. 계획이 없거나 낼 문항이 없으면 null */
export async function startToday(certCode: string, now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx?.settings) return null;
  const plan = enginePlan(ctx, now);
  if (!plan) return null;
  const entries = buildTodaySession(plan, startOfDay(now), SESSION_SIZE);
  if (!entries.length) return null;
  const run = await createSetRun(certCode, 'today', `오늘 학습 ${md(now)}`, entries.map((e) => e.qid), { now }, d);
  return { kind: 'set', sessionId: run.sessionId };
}

/** 오늘 학습에서 틀리거나 모른 문항을 한 번 더(6.5 세션 끝 재출제) */
export async function startRetry(certCode: string, qids: string[], now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  if (!qids.length) return null;
  const run = await createSetRun(certCode, 'today', `오늘 학습 ${md(now)} · 틀린 문항 다시`, qids, { now }, d);
  return { kind: 'set', sessionId: run.sessionId };
}

/** 모의고사: 현행 과목별 실제 문항 수, 출제빈도 가중 무작위(ADR 006), 문항당 1.5분 */
export async function startMock(certCode: string, now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx) return null;
  const mock = buildMock(ctx.bank, ctx.mem, { seed: now % 2_147_483_647, now });
  if (!mock.qids.length) return null;
  const run = await createSetRun(certCode, 'mock', `모의고사 ${md(now)}`, mock.qids, { now, limitSec: mock.minutes * 60 }, d);
  return { kind: 'set', sessionId: run.sessionId };
}

export interface MockRecord {
  sessionId: string;
  title: string;
  startedAt: number;
  finished: boolean;
  result: Result;
}

/** 모의고사 이력(성적만 — ADR 004) */
export async function mockHistory(certCode: string, d: OneQDB = defaultDb): Promise<MockRecord[]> {
  const out: MockRecord[] = [];
  for (const r of await setRuns(certCode, 'mock', d)) {
    const s = await loadSession({ kind: 'set', sessionId: r.sessionId }, d);
    if (!s) continue;
    out.push({ sessionId: r.sessionId, title: r.title, startedAt: r.startedAt, finished: r.finishedAt != null, result: await sessionResult(s, d) });
  }
  return out;
}

/**
 * 합격 기준 경고의 권장 시간을 남은 날 모두에 적용한다(오늘부터 시험 전날까지, 이미 더 길게 정한 날은 그대로).
 * 사용자가 버튼으로 고른 경우에만 — 앱이 마음대로 바꾸지 않는다
 */
export async function applyMinutes(certCode: string, settings: PlanSettings, minutes: number, now = Date.now(), d: OneQDB = defaultDb): Promise<void> {
  const dayMinutes = { ...(settings.dayMinutes ?? {}) };
  const last = addDays(parseDate(settings.examDate), -1);
  for (let t = startOfDay(now); t <= last; t = addDays(t, 1)) {
    const k = formatDate(t);
    dayMinutes[k] = Math.max(dayMinutes[k] ?? 0, minutes);
  }
  await savePlanSettings(certCode, { examDate: settings.examDate, dayMinutes }, d);
}

/** 120 → "2시간", 150 → "2시간 30분", 45 → "45분" */
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? (r ? `${h}시간 ${r}분` : `${h}시간`) : `${r}분`;
}
