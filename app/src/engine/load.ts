/**
 * DB → 엔진 입력. 엔진 본체(순수 함수)와 DB를 잇는 유일한 곳.
 * 5단계 홈·오늘 학습·모의고사 화면이 이 함수들을 부른다.
 */
import { db as defaultDb, getSetting, safeWrite, setSetting, type OneQDB } from '../db';
import { buildBank, type Bank } from './items';
import { buildConcepts, type Concepts, type ExamShares } from './similar';
import { replay, type MemoryState } from './memory';
import { forecast, type Forecast } from './predict';
import { planWeek, type WeeklyPlan } from './plan';
import { passOutlook, type PassOutlook } from './outlook';
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
  // 바꾼 시각을 함께 — 다른 기기 백업을 합칠 때 더 최신 계획이 이긴다(v0.9.2)
  await safeWrite('학습 계획 저장', () => d.settings.put({ key: planSettingKey(certCode), value: { ...cur, ...s }, updatedAt: Date.now() }));
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
  const sig = packs.map((p) => `${p.packId}:${p.manifest.packVersion}`).sort().join('|') + `#${bank.items.length}`;
  Object.assign(bank, await conceptsFor(certCode, sig, bank, questions, d));
  // 모의고사 풀이는 학습 엔진(기억·점수·추천)에 넣지 않는다 — 모의고사는 모의고사 이력에서만(실기기 v0.5.0, ADR 011)
  const attempts: EngineAttempt[] = (await d.attempts.where('qid').anyOf(rows.map((q) => q.qid)).toArray()).filter((a) => a.mode !== 'mock').map((a) => ({
    qid: a.qid,
    ts: a.ts,
    correct: a.correct,
    chosen: a.chosen,
    easy: a.easy,
    elapsedMs: a.elapsedMs,
    mode: a.mode,
  }));
  const settings = await loadPlanSettings(certCode, d);
  if (settings) settings.passRule = { ...latest.manifest.passRule, ...settings.passRule };
  return { certCode, bank, mem: replay(bank, attempts), attempts, settings };
}

/**
 * 유사 문항 군집(ADR 013)은 팩 구성이 바뀔 때만 다시 계산한다(3천 문항 Node 약 0.4초 — 휴대폰은 더 걸림).
 * 메모리(이번 실행) → DB 설정(`concepts:<종목>`, 학습 단위 순서의 군집 번호) 순으로 찾는다.
 */
const conceptCache = new Map<string, { idx: number[]; shares: ExamShares }>();

async function conceptsFor(certCode: string, sig: string, bank: Bank, questions: EngineQuestion[], d: OneQDB): Promise<{ concepts: Concepts; shares: ExamShares }> {
  const key = `concepts:${certCode}`;
  let hit = conceptCache.get(`${key}@${sig}`);
  if (!hit) {
    const saved = await getSetting<{ sig: string; idx: number[]; shares: ExamShares } | null>(key, null, d);
    if (saved?.sig === sig && saved.idx.length === bank.items.length) hit = { idx: saved.idx, shares: saved.shares };
  }
  if (!hit) {
    const text = new Map(questions.map((q) => [q.qid, q.text]));
    const { concepts, shares } = buildConcepts(bank, (q) => text.get(q) ?? '');
    const pos = new Map(bank.items.map((it, i) => [it.key, i]));
    hit = { idx: bank.items.map((it) => pos.get(concepts.clusterOf.get(it.key)!)!), shares };
    await setSetting(key, { sig, ...hit }, d);
  }
  conceptCache.set(`${key}@${sig}`, hit);
  const clusterOf = new Map<string, string>();
  const members = new Map<string, Bank['items']>();
  bank.items.forEach((it, i) => {
    const id = bank.items[hit!.idx[i]].key;
    clusterOf.set(it.key, id);
    (members.get(id) ?? members.set(id, []).get(id)!).push(it);
  });
  return { concepts: { clusterOf, members }, shares: hit.shares };
}

export function engineForecast(ctx: EngineContext): Forecast | null {
  return ctx.settings ? forecast(ctx.bank, ctx.mem, ctx.settings.examDate, ctx.settings.passRule, ctx.settings.safetyMargin) : null;
}

export function enginePlan(ctx: EngineContext, now = Date.now()): WeeklyPlan | null {
  return ctx.settings ? planWeek({ bank: ctx.bank, mem: ctx.mem, attempts: ctx.attempts, settings: ctx.settings, now }) : null;
}

/** 합격 기준 경고(홈 경고 카드, 5단계) */
export function engineOutlook(ctx: EngineContext, now = Date.now()): PassOutlook | null {
  return ctx.settings ? passOutlook(ctx.bank, ctx.mem, ctx.settings, now) : null;
}

export function engineToday(ctx: EngineContext, now = Date.now()): SessionEntry[] {
  const plan = enginePlan(ctx, now);
  return plan ? buildTodaySession(plan, startOfDay(now)) : [];
}

export function engineMock(ctx: EngineContext, seed: number, strategy?: MockStrategy, now = Date.now()): MockExam {
  return buildMock(ctx.bank, ctx.mem, { seed, strategy, now });
}
