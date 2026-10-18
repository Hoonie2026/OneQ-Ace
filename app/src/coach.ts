/**
 * 홈 대시보드·오늘 학습·모의고사를 학습 엔진에 잇는 곳(5단계). 화면은 엔진을 직접 부르지 않고 이 파일을 쓴다.
 */
import { db as defaultDb, type OneQDB } from './db';
import { addDays, formatDate, parseDate, startOfDay } from './engine/days';
import {
  buildMock,
  buildSubjectSession,
  buildTodaySession,
  dueCounts,
  examScore,
  newItemRates,
  recordedScores,
  repeatShare,
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
} from './engine';
import { OUTLOOK_MIN_OBS } from './engine/outlook';
import { createSetRun, loadSession, sessionResult, setRuns, type Result, type Target } from './study';

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
  /** 복습할 때가 된 문항 수 / 풀어 본 학습 단위 / 전체 학습 단위 / 보유 문항 수 */
  due: number;
  seen: number;
  items: number;
  questions: number;
  recommended: boolean;
}

export type ExamStatus = 'unknown' | 'pass' | 'tight' | 'avg-short' | 'fail-subject' | 'no-plan';

export interface ExamView {
  rho: number;
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
  const { subjects, exam } = examViews(ctx, forecast, outlook, now);
  return { ctx, subjects, exam, settings: ctx.settings, plan: enginePlan(ctx, now), forecast, outlook, doneToday, openToday };
}

/** 과목 카드와 실제 시험 기준 예상(ADR 008) */
export function examViews(ctx: EngineContext, forecast: Forecast | null, outlook: PassOutlook | null, now: number): { subjects: SubjectView[]; exam: ExamView } {
  const { bank, mem, attempts } = ctx;
  const rs = repeatShare(bank);
  const rates = newItemRates(bank, attempts);
  const rec = recordedScores(bank, attempts);
  const due = dueCounts(bank, mem, now);
  const rule = ctx.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  const current = bank.subjects.filter((s) => s.current);
  const bankNow = new Map((forecast?.subjects ?? []).map((s) => [s.key, s.score]));
  const bankProj = new Map((outlook?.subjects ?? []).map((s) => [s.key, s.projected]));
  const views: SubjectView[] = current.map((s) => {
    const its = bank.items.filter((it) => it.subjectKey === s.key);
    const rate = rates.get(s.key)!;
    const bp = bankProj.get(s.key);
    return {
      key: s.key,
      name: s.name,
      current: rec.get(s.key) ?? 0,
      examNow: examScore(bankNow.get(s.key) ?? 100 * rate.exam, rate, rs.rho),
      examProjected: bp == null ? null : examScore(bp, rate, rs.rho),
      newRate: rate,
      needNewRate: bp == null ? null : Math.max(0, Math.min(1, (rule.subjectMin - rs.rho * bp) / (1 - rs.rho) / 100)),
      due: due.get(s.key) ?? 0,
      seen: its.filter((it) => mem.items.has(it.key)).length,
      items: its.length,
      questions: bank.questionCount.get(s.key) ?? 0,
      recommended: false,
    };
  });
  // 오늘 추천: 진단이 덜 된 과목(첫 풀이가 가장 적은) → 시험 기준 예상이 가장 낮은 과목. 낼 문항이 없는 과목은 빼고
  const cand = views.filter((v) => v.due > 0 || v.seen < v.items);
  const undiag = cand.filter((v) => (mem.priorObs.get(v.key) ?? 0) < OUTLOOK_MIN_OBS);
  const pickFrom = undiag.length ? undiag.sort((a, b) => (mem.priorObs.get(a.key) ?? 0) - (mem.priorObs.get(b.key) ?? 0)) : cand.sort((a, b) => (a.examProjected ?? a.examNow) - (b.examProjected ?? b.examNow) || b.due - a.due);
  if (pickFrom[0]) pickFrom[0].recommended = true;
  // 순서는 과목 순서대로(정렬로 바뀐 배열이 아니라 원래 배열)
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
    exam: { rho: rs.rho, rounds: new Set(bank.examDateOf.values()).size, currentAvg: avg(views.map((v) => v.current)), projectedAvg: projected, status, failSubjects: fail },
  };
}

/** 과목별 학습 한 세션(15문항, 자동 순서) */
export async function startSubject(certCode: string, subjectKey: string, now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx) return null;
  const entries = buildSubjectSession(ctx.bank, ctx.mem, subjectKey, now, ctx.attempts, SESSION_SIZE);
  if (!entries.length) return null;
  const name = ctx.bank.subjects.find((s) => s.key === subjectKey)?.name ?? '과목';
  const run = await createSetRun(certCode, 'today', `${name} 학습`, entries.map((e) => e.qid), { now }, d);
  return { kind: 'set', sessionId: run.sessionId };
}

/** 문항의 출제 이력: 같은 내용이 나온 회차들(최근 순). 1회면 빈 배열 대신 그 회차 하나 */
export async function questionHistory(certCode: string, d: OneQDB = defaultDb): Promise<Map<string, string[]>> {
  const ctx = await loadEngine(certCode, d);
  const out = new Map<string, string[]>();
  if (!ctx) return out;
  const label = (qid: string) => {
    const y = (ctx.bank.examDateOf.get(qid) ?? '').split('-')[0];
    const round = qid.split('-').slice(-2, -1)[0];
    return y ? `${y}년 ${round}회` : qid;
  };
  for (const it of ctx.bank.items) {
    const rounds = [...new Set(it.qids.map(label))];
    for (const q of it.qids) out.set(q, rounds);
  }
  return out;
}

const md = (ts: number) => new Date(ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

/** 과목을 섞은 오늘 학습 한 세션(15문항). 화면에서는 쓰지 않음(ADR 008 — 과목별 + 오늘 추천으로 대체), 시험·이후 후반 섞기 학습용으로 남김 */
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
  const run = await createSetRun(certCode, 'today', '틀린·모름 문항 다시', qids, { now }, d);
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
