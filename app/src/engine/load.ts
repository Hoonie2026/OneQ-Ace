/**
 * DB → 엔진 입력. 엔진 본체(순수 함수)와 DB를 잇는 유일한 곳.
 * 5단계 홈·오늘 학습·모의고사 화면이 이 함수들을 부른다.
 */
import { db as defaultDb, getSetting, setSetting, type OneQDB } from '../db';
import { buildBank, type Bank } from './items';
import { replay, type MemoryState } from './memory';
import { forecast, type Forecast } from './predict';
import { planWeek, type WeeklyPlan } from './plan';
import { buildTodaySession, type SessionEntry } from './session';
import { buildMock, type MockExam, type MockStrategy } from './mock';
import { startOfDay } from './days';
import { DEFAULT_PLAN_SETTINGS, type EngineAttempt, type EngineQuestion, type PlanSettings } from './types';

export const planSettingKey = (certCode: string) => `plan:${certCode}`;

export interface EngineContext {
  certCode: string;
  bank: Bank;
  mem: MemoryState;
  attempts: EngineAttempt[];
  settings: PlanSettings | null; // 시험일을 아직 정하지 않았으면 null
}

export async function loadPlanSettings(certCode: string, d: OneQDB = defaultDb): Promise<PlanSettings | null> {
  const s = await getSetting<Partial<PlanSettings> | null>(planSettingKey(certCode), null, d);
  if (!s?.examDate) return null;
  return { ...DEFAULT_PLAN_SETTINGS, ...s, passRule: { ...DEFAULT_PLAN_SETTINGS.passRule, ...s.passRule } } as PlanSettings;
}

export async function savePlanSettings(certCode: string, s: Partial<PlanSettings> & { examDate: string }, d: OneQDB = defaultDb): Promise<void> {
  const cur = (await getSetting<Partial<PlanSettings> | null>(planSettingKey(certCode), null, d)) ?? {};
  await setSetting(planSettingKey(certCode), { ...cur, ...s }, d);
}

export async function loadEngine(certCode: string, d: OneQDB = defaultDb): Promise<EngineContext | null> {
  const packs = (await d.packs.toArray()).filter((p) => p.manifest.cert.code === certCode);
  if (!packs.length) return null;
  const latest = [...packs].sort((a, b) => (a.manifest.exam.date < b.manifest.exam.date ? 1 : -1))[0];
  const dateOf = new Map(packs.map((p) => [p.packId, p.manifest.exam.date]));
  const subjName = new Map(packs.map((p) => [p.packId, new Map(p.manifest.subjects.map((s) => [s.no, s.name]))]));
  const rows = await d.questions.where('packId').anyOf([...dateOf.keys()]).toArray();
  const questions: EngineQuestion[] = rows.map((q) => ({
    qid: q.qid,
    packId: q.packId,
    examDate: dateOf.get(q.packId)!,
    subjectName: subjName.get(q.packId)?.get(q.subjectNo) ?? `${q.subjectNo}과목`,
    text: q.text ?? '',
    clusterId: q.clusterId ?? null,
  }));
  const bank = buildBank(questions, latest.manifest.subjects.map((s) => ({ name: s.name, count: s.count })));
  const attempts: EngineAttempt[] = (await d.attempts.where('qid').anyOf(rows.map((q) => q.qid)).toArray()).map((a) => ({
    qid: a.qid,
    ts: a.ts,
    correct: a.correct,
    chosen: a.chosen,
    unsure: a.unsure,
    elapsedMs: a.elapsedMs,
  }));
  const settings = await loadPlanSettings(certCode, d);
  if (settings) settings.passRule = { ...latest.manifest.passRule, ...settings.passRule };
  return { certCode, bank, mem: replay(bank, attempts), attempts, settings };
}

export function engineForecast(ctx: EngineContext): Forecast | null {
  return ctx.settings ? forecast(ctx.bank, ctx.mem, ctx.settings.examDate, ctx.settings.passRule, ctx.settings.safetyMargin) : null;
}

export function enginePlan(ctx: EngineContext, now = Date.now()): WeeklyPlan | null {
  return ctx.settings ? planWeek({ bank: ctx.bank, mem: ctx.mem, attempts: ctx.attempts, settings: ctx.settings, now }) : null;
}

export function engineToday(ctx: EngineContext, now = Date.now()): SessionEntry[] {
  const plan = enginePlan(ctx, now);
  return plan ? buildTodaySession(plan, startOfDay(now)) : [];
}

export function engineMock(ctx: EngineContext, seed: number, strategy?: MockStrategy, now = Date.now()): MockExam {
  return buildMock(ctx.bank, ctx.mem, { seed, strategy, now });
}
