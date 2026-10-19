/**
 * 홈 대시보드·오늘 학습·모의고사를 학습 엔진에 잇는 곳(5단계). 화면은 엔진을 직접 부르지 않고 이 파일을 쓴다.
 */
import { db as defaultDb, type OneQDB } from './db';
import { addDays, formatDate, parseDate, startOfDay } from './engine/days';
import {
  buildMock,
  availableCounts,
  buildDailySession,
  minutesToday,
  buildSubjectSession,
  examScoreMix,
  needRateMix,
  newItemRates,
  projectedRate,
  recordedScores,
  engineForecast,
  engineOutlook,
  enginePlan,
  loadEngine,
  savePlanSettings,
  SESSION_SIZE,
  type EngineContext,
  type Forecast,
  type NewRate,
  type PassOutlook,
  type PlanSettings,
  type WeeklyPlan,
  DEFAULT_PLAN_SETTINGS,
} from './engine';
import { LEARNED_R, OUTLOOK_MIN_OBS } from './engine/outlook';
import { TRANSFER_REF_ITEMS } from './engine/exam';
import { trivialConcepts, type ExamShares } from './engine/similar';
import { createSetRun, finishRun, loadSession, sessionResult, setRuns, type Result, type Target } from './study';

/** 과목 카드 하나(과목별 학습 화면) */
export interface SubjectView {
  key: string;
  name: string;
  /** 현재 점수(기록 그대로: 최근 답, 안 푼 문항·모름·오답 0점) */
  current: number;
  /** 실제 시험 기준 — 지금 / 계획대로 하면 시험일 */
  examNow: number;
  examProjected: number | null;
  /** 처음 보는 문항 정답률(최근 첫 풀이) */
  newRate: NewRate;
  /** 과락선을 넘기는 데 필요한 처음 보는 문항 정답률(시험 기준, 0~1). 계획이 없으면 null */
  needNewRate: number | null;
  /** 오늘 낼 수 있는 문항: 오늘 틀린 것 다시 / 복습할 때가 된 것 / 새 문항(세션 구성과 같은 규칙) */
  avail: { relearn: number; due: number; fresh: number };
  /** 이 과목 풀이 횟수(모의고사 제외)와 마지막으로 푼 시각 */
  solves: number;
  lastTs: number | null;
  /** 풀어 본 학습 단위 / 전체 학습 단위 / 보유 문항 수 */
  seen: number;
  items: number;
  questions: number;
  recommended: boolean;
}

export type ExamStatus = 'unknown' | 'pass' | 'tight' | 'avg-short' | 'fail-subject' | 'no-plan';

export interface ExamView {
  /** 기출(같은 문항 + 변형) 비율 — 시험 문항 중 보유 기출로 대비되는 몫 */
  rho: number;
  /** 시험 구성: 같은 기출 / 변형 / 처음 보는 문항(ADR 013) */
  shares: ExamShares;
  rounds: number;
  /** 현재 평균(기록 그대로) / 실제 시험 기준 예상 평균(계획대로, 계획 없으면 null) */
  currentAvg: number;
  projectedAvg: number | null;
  status: ExamStatus;
  failSubjects: string[];
}

export interface Coach {
  ctx: EngineContext;
  subjects: SubjectView[];
  exam: ExamView;
  settings: PlanSettings | null;
  plan: WeeklyPlan | null;
  forecast: Forecast | null;
  outlook: PassOutlook | null;
  /** 오늘 푼 문항 수(이 종목, 모든 풀이) */
  doneToday: number;
  /** 끝나지 않은 학습 묶음(이어서 풀기) */
  openToday: { sessionId: string; left: number; title: string } | null;
  /** 오늘 학습 과목 우선순위(맨 앞 = 추천). 낼 문항이 없는 과목은 빠진다 */
  order: string[];
  /** 오늘 학습 미리보기(ADR 010): 오늘 계획 시간·문항 수와, 지금 시작하면 나올 구성 */
  today: TodayPlan;
}

export interface TodayPlan {
  /** 오늘 계획 학습시간(분)과 그 시간에 풀 문항 수(계획이 없으면 기본 하루 60분) */
  minutes: number;
  target: number;
  /** 지금 시작하면 낼 문항 수 = 오늘 남은 계획량(다 했으면 추가 15문항) */
  size: number;
  extra: boolean;
  /** 구성(왜 나오는지): 오늘 틀린 문항 다시 / 지난번 틀린·모름 복습 / 맞혔지만 다시 볼 때 된 문항 / 새 문항 */
  relearn: number;
  wrong: number;
  review: number;
  fresh: number;
  bySubject: { name: string; review: number; fresh: number }[];
}

/** 오늘 계획량을 다 한 뒤 더 할 때 한 번에 내는 문항 수 */
export const EXTRA_SIZE = 15;

function todayPlan(ctx: EngineContext, order: string[], doneToday: number, now: number): TodayPlan {
  const settings = ctx.settings ?? { ...DEFAULT_PLAN_SETTINGS, examDate: '9999-12-31' };
  const minutes = minutesToday(settings, startOfDay(now));
  const target = Math.max(0, Math.round((minutes * 60) / ctx.mem.secPerQuestion));
  const left = target - doneToday;
  const extra = left <= 0;
  const want = extra ? EXTRA_SIZE : left;
  const entries = buildDailySession(ctx.bank, ctx.mem, order, now, ctx.attempts, want);
  const count = (k: string) => entries.filter((e) => e.kind === k).length;
  const by = new Map<string, { name: string; review: number; fresh: number }>();
  for (const e of entries) {
    const name = ctx.bank.subjects.find((x) => x.key === e.subjectKey)?.name ?? '';
    const b = by.get(name) ?? { name, review: 0, fresh: 0 };
    if (e.slot === 'new') b.fresh++;
    else b.review++;
    by.set(name, b);
  }
  return {
    minutes,
    target,
    size: entries.length,
    extra,
    relearn: count('relearn'),
    wrong: count('wrong'),
    review: count('review'),
    fresh: count('new'),
    bySubject: [...by.values()].sort((a, b) => b.review + b.fresh - (a.review + a.fresh)),
  };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const avg = (xs: number[]) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

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
  const forecast = engineForecast(ctx);
  const outlook = engineOutlook(ctx, now);
  const { subjects, exam, order } = examViews(ctx, forecast, outlook, now);
  return { ctx, subjects, exam, order, today: todayPlan(ctx, order, doneToday, now), settings: ctx.settings, plan: enginePlan(ctx, now), forecast, outlook, doneToday, openToday };
}

/** 과목 카드와 실제 시험 기준 예상(ADR 008) */
export function examViews(ctx: EngineContext, forecast: Forecast | null, outlook: PassOutlook | null, now: number): { subjects: SubjectView[]; exam: ExamView; order: string[] } {
  const { bank, mem, attempts } = ctx;
  const shares = bank.shares ?? trivialConcepts(bank).shares;
  const rates = newItemRates(bank, attempts);
  const rec = recordedScores(bank, attempts);
  const avail = availableCounts(bank, mem, now, attempts);
  const rule = ctx.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const current = bank.subjects.filter((s) => s.current);
  const bankNow = new Map((forecast?.subjects ?? []).map((s) => [s.key, s.score]));
  const bankProj = new Map((outlook?.subjects ?? []).map((s) => [s.key, s.projected]));
  const itemsOf = new Map(current.map((s) => [s.key, bank.items.filter((it) => it.subjectKey === s.key)]));
  const seenOf = new Map(current.map((s) => [s.key, itemsOf.get(s.key)!.filter((it) => mem.items.has(it.key)).length]));
  const solvesOf = new Map<string, { n: number; last: number }>();
  for (const a of attempts) {
    const sk = bank.itemOf.get(a.qid)?.subjectKey;
    if (!sk) continue;
    const v = solvesOf.get(sk) ?? { n: 0, last: 0 };
    v.n++;
    v.last = Math.max(v.last, a.ts);
    solvesOf.set(sk, v);
  }
  const views: SubjectView[] = current.map((s) => {
    const its = itemsOf.get(s.key)!;
    const rate = rates.get(s.key)!;
    const bp = bankProj.get(s.key);
    const bn = bankNow.get(s.key) ?? 100 * rate.exam;
    // 시험일까지 새로 익힐 기출 몫(ADR 011·013): 투영에서 오른 기출 점수 ÷ 다 익혔을 때 오를 수 있는 폭
    const prior = mem.prior.get(s.key) ?? 0.25;
    const room = 100 * (LEARNED_R + (1 - LEARNED_R) * prior - prior);
    const gain = (bp == null || room <= 0 ? 0 : Math.max(0, Math.min(1, (bp - bn) / room))) * Math.min(1, its.length / TRANSFER_REF_ITEMS);
    const rateT = projectedRate(rate, gain);
    return {
      key: s.key,
      name: s.name,
      current: rec.get(s.key) ?? 0,
      examNow: examScoreMix(bn, rate, shares),
      examProjected: bp == null ? null : examScoreMix(bp, rateT, shares),
      newRate: rate,
      needNewRate: bp == null ? null : needRateMix(rule.subjectMin, bp, shares),
      avail: avail.get(s.key) ?? { relearn: 0, due: 0, fresh: 0 },
      seen: seenOf.get(s.key)!,
      solves: solvesOf.get(s.key)?.n ?? 0,
      lastTs: solvesOf.get(s.key)?.last ?? null,
      items: its.length,
      questions: bank.questionCount.get(s.key) ?? 0,
      recommended: false,
    };
  });
  // 오늘 학습 과목 순서: 진단이 덜 된 과목(첫 풀이가 적은 순) → 시험 기준 예상이 낮은 순. 낼 문항이 없는 과목은 빼고
  const n = (v: SubjectView) => v.avail.relearn + v.avail.due + v.avail.fresh;
  const obs = (v: SubjectView) => mem.priorObs.get(v.key) ?? 0;
  const ordered = views
    .filter((v) => n(v) > 0)
    .sort((a, b) => Number(obs(b) < OUTLOOK_MIN_OBS) - Number(obs(a) < OUTLOOK_MIN_OBS) || (obs(a) < OUTLOOK_MIN_OBS ? obs(a) - obs(b) : 0) || (a.examProjected ?? a.examNow) - (b.examProjected ?? b.examNow) || n(b) - n(a));
  if (ordered[0]) ordered[0].recommended = true;
  const projected = views.every((v) => v.examProjected != null) ? avg(views.map((v) => v.examProjected!)) : null;
  const fail = views.filter((v) => v.examProjected != null && v.examProjected < rule.subjectMin).map((v) => v.name);
  const m = ctx.settings?.safetyMargin ?? 10;
  let status: ExamStatus;
  if (!ctx.settings || !outlook || projected == null) status = 'no-plan';
  else if (outlook.rough) status = 'unknown';
  else if (fail.length) status = 'fail-subject';
  else if (projected < rule.avgMin) status = 'avg-short';
  else if (views.some((v) => v.examProjected! < rule.subjectMin + m / 2) || projected < rule.avgMin + m / 2) status = 'tight';
  else status = 'pass';
  return {
    subjects: views,
    order: ordered.map((v) => v.key),
    exam: { rho: shares.same + shares.variant, shares, rounds: new Set(bank.examDateOf.values()).size, currentAvg: avg(views.map((v) => v.current)), projectedAvg: projected, status, failSubjects: fail },
  };
}

/** 과목별 학습 한 세션(15문항, 자동 순서) */
export async function startSubject(certCode: string, subjectKey: string, now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx) return null;
  const entries = buildSubjectSession(ctx.bank, ctx.mem, subjectKey, now, ctx.attempts, SESSION_SIZE);
  if (!entries.length) return null;
  const name = ctx.bank.subjects.find((s) => s.key === subjectKey)?.name ?? '과목';
  const run = await createSetRun(certCode, 'today', `${name} 학습`, entries.map((e) => e.qid), { now, subjectKey }, d);
  return { kind: 'set', sessionId: run.sessionId };
}

/** 문항의 출제 이력: 같은 내용이 나온 회차들(최근 순). 1회면 빈 배열 대신 그 회차 하나 */
export async function questionHistory(certCode: string, d: OneQDB = defaultDb): Promise<Map<string, string[]>> {
  return (await questionMeta(certCode, d)).history;
}

/** 출제 이력 + 같은 내용 문항들(다른 회차에 쓴 메모를 보여 주는 데 — v0.7) */
export async function questionMeta(certCode: string, d: OneQDB = defaultDb): Promise<{ history: Map<string, string[]>; siblings: Map<string, string[]> }> {
  const ctx = await loadEngine(certCode, d);
  const out = new Map<string, string[]>();
  const siblings = new Map<string, string[]>();
  if (!ctx) return { history: out, siblings };
  const label = (qid: string) => {
    const y = (ctx.bank.examDateOf.get(qid) ?? '').split('-')[0];
    const round = qid.split('-').slice(-2, -1)[0];
    return y ? `${y}년 ${round}회` : qid;
  };
  for (const it of ctx.bank.items) {
    const rounds = [...new Set(it.qids.map(label))];
    for (const q of it.qids) {
      out.set(q, rounds);
      siblings.set(q, it.qids.filter((x) => x !== q));
    }
  }
  return { history: out, siblings };
}

export const md = (ts: number) => new Date(ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

/**
 * 오늘 학습(ADR 009·010 — 홈의 기본 입구): **오늘 남은 계획량 전체를 한 묶음으로**(다 했으면 추가 15문항).
 * 순서: 오늘 틀린 문항 다시 → 추천 과목(복습할 때가 된 것 → 출제빈도 높은 새 문항) → 다음 순위 과목.
 * 묶음을 다 풀면 틀린 문항을 한 번 더(startRelearn)
 */
export async function startToday(certCode: string, now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx) return null;
  const { order } = examViews(ctx, engineForecast(ctx), engineOutlook(ctx, now), now);
  const doneToday = ctx.attempts.filter((a) => a.ts >= startOfDay(now)).length;
  const tp = todayPlan(ctx, order, doneToday, now);
  const entries = buildDailySession(ctx.bank, ctx.mem, order, now, ctx.attempts, tp.extra ? EXTRA_SIZE : Math.max(1, tp.target - doneToday));
  if (!entries.length) return null;
  const run = await createSetRun(certCode, 'today', '오늘 학습', entries.map((e) => e.qid), { now }, d);
  return { kind: 'set', sessionId: run.sessionId };
}

/** 오늘 학습 진행(v0.7.1): 목표 문항 수와 오늘 푼 결과(모의고사 제외). 풀이 화면이 "오늘 목표 달성" 상자에 쓴다 */
export interface TodayStatus {
  target: number;
  done: number;
  correct: number;
  wrong: number;
  unknown: number;
}

export async function todayStatus(certCode: string, now = Date.now(), d: OneQDB = defaultDb): Promise<TodayStatus | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx) return null;
  const settings = ctx.settings ?? { ...DEFAULT_PLAN_SETTINGS, examDate: '9999-12-31' };
  const target = Math.max(0, Math.round((minutesToday(settings, startOfDay(now)) * 60) / ctx.mem.secPerQuestion));
  const todays = ctx.attempts.filter((a) => a.ts >= startOfDay(now));
  const correct = todays.filter((a) => a.correct).length;
  const unknown = todays.filter((a) => a.chosen === 0).length;
  return { target, done: todays.length, correct, wrong: todays.length - correct - unknown, unknown };
}

/**
 * 오늘 학습 마치기(v0.7.1 — 실기기 의견): 열려 있는 오늘 학습 묶음을 닫는다. 푼 기록은 원장에 그대로 남고,
 * 홈은 "이어서 학습" 대신 "시스템 추천 학습"을 보여 준다(남은 문항은 다음 추천에서 오늘 기록을 바탕으로 다시 고른다)
 */
export async function finishToday(certCode: string, now = Date.now(), d: OneQDB = defaultDb): Promise<number> {
  const open = (await setRuns(certCode, 'today', d)).filter((r) => !r.finishedAt);
  for (const r of open) await finishRun(r.sessionId, now, d);
  return open.length;
}

/** 오늘 학습 묶음 끝: 그 묶음에서 틀리거나 모른 문항을 한 번 더(같은 흐름 안에서 바로 이어짐) */
export async function startRelearn(certCode: string, qids: string[], now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  if (!qids.length) return null;
  const run = await createSetRun(certCode, 'today', '오늘 학습 · 틀린 문항 한 번 더', qids, { now, relearn: true }, d);
  return { kind: 'set', sessionId: run.sessionId };
}

export interface DaySummary {
  date: string;
  answered: number;
  correct: number;
  unknown: number;
  minutes: number;
  bySubject: { name: string; answered: number; correct: number }[];
  currentAvg: number;
  projectedAvg: number | null;
  passRule: { subjectMin: number; avgMin: number };
  /** 계획대로 해도 합격선(평균·과락)에 못 미치는가. 계획이 없거나 진단 전이면 null */
  short: boolean | null;
  lowSubjects: string[];
}

/** 오늘 학습 마치기(ADR 009): 오늘 푼 것 + 현재 점수 → 계획대로 하면 예상 점수. 모의고사 풀이도 포함 */
export async function daySummary(certCode: string, now = Date.now(), d: OneQDB = defaultDb): Promise<DaySummary | null> {
  const c = await loadCoach(certCode, now, d);
  if (!c) return null;
  const today = startOfDay(now);
  const todays = c.ctx.attempts.filter((a) => a.ts >= today);
  const rule = c.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const by = new Map<string, { name: string; answered: number; correct: number }>();
  for (const a of todays) {
    const it = c.ctx.bank.itemOf.get(a.qid);
    const name = c.ctx.bank.subjects.find((s) => s.key === it?.subjectKey)?.name ?? '기타';
    const b = by.get(name) ?? { name, answered: 0, correct: 0 };
    b.answered++;
    if (a.correct) b.correct++;
    by.set(name, b);
  }
  const short = c.exam.projectedAvg == null || c.exam.status === 'unknown' ? null : c.exam.status === 'fail-subject' || c.exam.status === 'avg-short';
  return {
    date: formatDate(today),
    answered: todays.length,
    correct: todays.filter((a) => a.correct).length,
    unknown: todays.filter((a) => a.chosen === 0).length,
    minutes: Math.round(todays.reduce((t, a) => t + Math.min(a.elapsedMs, 600_000), 0) / 60_000),
    bySubject: c.subjects.map((s) => by.get(s.name)).filter((x): x is NonNullable<typeof x> => !!x),
    currentAvg: c.exam.currentAvg,
    projectedAvg: c.exam.projectedAvg,
    passRule: rule,
    short,
    lowSubjects: c.subjects.filter((s) => s.examProjected != null && s.examProjected < rule.subjectMin).map((s) => s.name),
  };
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
