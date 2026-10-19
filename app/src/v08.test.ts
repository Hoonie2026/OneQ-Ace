/** v0.8.0(ADR 014): 실제 학습량 점검·필요 학습시간·추천 묶음(과목 진단·시험 직전 총정리) */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBank, replay, DEFAULT_PLAN_SETTINGS, engineForecast, engineOutlook, type EngineAttempt, type PlanSettings } from './engine';
import { addDays, formatDate, startOfDay } from './engine/days';
import { examRecall, recallAt } from './engine/memory';
import { buildDailySession, DIAG_OBS, FINAL_DAYS } from './engine/session';
import { syntheticBank } from './engine/sim';
import { rng } from './engine';
import { examViews, loadCoach, type Coach } from './coach';
import { computeInsight, recentPace, requiredDaily, scaledSettings, projectWith, PACE_MIN_DAYS } from './insight';
import { OneQDB } from './db';
import { savePlanSettings } from './engine';
import { importPackBytes } from './pack/import';
import { makePack } from './test/makePack';

const T0 = new Date(2027, 0, 4, 9).getTime(); // 월요일 9시

/** 합성 은행(5과목 × 20문항 × 회차) + 앞 days일 동안 하루 perDay문항, 정답률 rate */
function world(rounds: number, days: number, perDay: number, rate: number, settings: Partial<PlanSettings> = {}) {
  const bank = buildBank(syntheticBank(rounds));
  const r = rng(5);
  const attempts: EngineAttempt[] = [];
  let k = 0;
  for (let d = days; d >= 1; d--) {
    for (let i = 0; i < perDay; i++) {
      const it = bank.items[(k++ * 7) % bank.items.length];
      attempts.push({ qid: it.qids[0], ts: addDays(T0, -d) + i * 90_000, correct: r() < rate, chosen: 1, unsure: false, elapsedMs: 60_000 });
    }
  }
  const mem = replay(bank, attempts);
  const s: PlanSettings = { ...DEFAULT_PLAN_SETTINGS, examDate: formatDate(addDays(T0, 40)), dailyMinutes: 60, studyDaysPerWeek: 7, dayMinutes: {}, ...settings };
  const ctx = { certCode: 'X', bank, mem, attempts, settings: s };
  const v = examViews(ctx, engineForecast(ctx), engineOutlook(ctx, T0), T0);
  const coach = { ctx, subjects: v.subjects, exam: v.exam, settings: s } as unknown as Coach;
  return { bank, mem, attempts, settings: s, ctx, coach };
}

describe('최근 실제 학습량(recentPace)', () => {
  it('어제까지 최근 기록으로 하루 평균 분과 계획 대비 비율', () => {
    const w = world(5, 10, 30, 0.6); // 하루 30문항 × 1분
    const p = recentPace(w.ctx, T0)!;
    expect(p.days).toBe(10);
    expect(p.activeDays).toBe(10);
    expect(p.minutesPerDay).toBeCloseTo(30, 5);
    expect(p.plannedPerDay).toBeCloseTo(60, 5);
    expect(p.ratio).toBeCloseTo(0.5, 5);
  });
  it(`기록이 ${PACE_MIN_DAYS}일 미만이면 판단하지 않는다`, () => {
    expect(recentPace(world(5, 2, 30, 0.6).ctx, T0)).toBeNull();
  });
});

describe('계획 비례 조정·필요 학습시간', () => {
  it('scaledSettings: 오늘부터의 날짜별 시간과 평소 시간을 같은 비율로, 지난 날은 그대로', () => {
    const today = formatDate(T0);
    const past = formatDate(addDays(T0, -3));
    const fut = formatDate(addDays(T0, 5));
    const s = scaledSettings({ ...DEFAULT_PLAN_SETTINGS, examDate: '2027-03-01', dailyMinutes: 60, dayMinutes: { [past]: 100, [today]: 120, [fut]: 300 } }, 0.5, T0);
    expect(s.dailyMinutes).toBe(30);
    expect(s.dayMinutes).toEqual({ [past]: 100, [today]: 60, [fut]: 150 });
  });
  it('필요 시간: 그 시간으로 계산하면 기준을 넘고, 최소 ≤ 여유. 시간이 늘면 예상도 오른다', () => {
    const w = world(12, 14, 60, 0.55);
    const safe = requiredDaily(w.ctx, T0, 'safe');
    const min = requiredDaily(w.ctx, T0, 'min');
    expect(safe).not.toBeNull();
    expect(min).not.toBeNull();
    expect(min!).toBeLessThanOrEqual(safe!);
    const at = (m: number) => projectWith(w.ctx, { ...w.settings, dailyMinutes: m }, T0)!;
    expect(at(240).avg).toBeGreaterThanOrEqual(at(30).avg);
    const p = at(safe!);
    const half = w.settings.safetyMargin / 2;
    expect(p.avg).toBeGreaterThanOrEqual(w.settings.passRule.avgMin + half);
    expect(Math.min(...p.subjects.map((x) => x.score))).toBeGreaterThanOrEqual(w.settings.passRule.subjectMin + half);
  });
  it('계획보다 적게 공부하면 "이 속도면" 예상을 따로 내고, 계획대로 한 것보다 낮다', () => {
    const w = world(12, 14, 20, 0.55, { dailyMinutes: 120 }); // 하루 20분 vs 계획 120분
    const ins = computeInsight(w.coach, T0);
    expect(ins.pace!.ratio).toBeLessThan(0.9);
    expect(ins.atPace).not.toBeNull();
    expect(ins.atPace!.avg).toBeLessThanOrEqual(ins.plan!.avg);
  });
});

describe('추천 묶음(ADR 014)', () => {
  it(`과목 진단: 진단이 덜 된 과목들의 새 문항을 번갈아(과목당 ${DIAG_OBS}문항까지)`, () => {
    const bank = buildBank(syntheticBank(5));
    const mem = replay(bank, []);
    const order = bank.subjects.map((s) => s.key);
    const e = buildDailySession(bank, mem, order, T0, [], 25);
    expect(new Set(e.slice(0, 5).map((x) => x.subjectKey)).size).toBe(5);
    const off = buildDailySession(bank, mem, order, T0, [], 25, { diag: false });
    expect(new Set(off.map((x) => x.subjectKey)).size).toBe(1); // 진단을 끄면 추천 과목만
  });
  it('새 문항 과목 배분: 점수를 주면 합격 확률 기여도 비례 — 낮은 과목이 가장 많이, 다른 과목도 조금씩', () => {
    const bank = buildBank(syntheticBank(5));
    const order = bank.subjects.map((s) => s.key);
    const mem = replay(bank, []);
    for (const k of order) mem.priorObs.set(k, 20); // 진단 끝
    const scores = new Map(order.map((k, i) => [k, i === 2 ? 38 : 60]));
    const e = buildDailySession(bank, mem, order, T0, [], 40, { scores, diag: false });
    const n = (k: string) => e.filter((x) => x.subjectKey === k).length;
    for (const k of order) if (k !== order[2]) expect(n(order[2])).toBeGreaterThan(2 * n(k)); // 과락선 근처 과목이 2배 넘게
    expect(order.filter((k) => n(k) > 0).length).toBe(5); // 평균도 모자라 다른 과목도 조금씩
  });
  it(`시험 직전 ${FINAL_DAYS}일: 복습 예정일이 아니어도 시험일 기억률이 낮은 순으로 총정리`, () => {
    const w = world(5, 20, 25, 0.7);
    const examDay = startOfDay(addDays(T0, 2)); // 시험 2일 전
    const order = w.bank.subjects.map((s) => s.key);
    const normal = buildDailySession(w.bank, w.mem, order, T0, w.attempts, 40);
    const final = buildDailySession(w.bank, w.mem, order, T0, w.attempts, 40, { examDay });
    const T = examDay + 9 * 3_600_000;
    const rev = final.filter((x) => x.kind !== 'new');
    expect(rev.length).toBeGreaterThan(0);
    const rs = rev.map((x) => recallAt(w.mem.items.get(x.itemKey)!.card, T, w.mem.curve));
    expect(Math.max(...rs)).toBeLessThan(0.95);
    // 평소 묶음과 복습 구성이 다르다(예정일 순 → 시험일 기억률 순)
    expect(rev.map((x) => x.itemKey).join()).not.toBe(normal.filter((x) => x.kind !== 'new').map((x) => x.itemKey).join());
    expect(final.length).toBe(40);
  });
});

describe('예상 점수의 긴 공백 보정(examRecall)', () => {
  it('안정도 안쪽은 FSRS 그대로, 오래 지나면 FSRS보다 낮게(두 모형 사이)', () => {
    const w = world(5, 20, 25, 0.8);
    const m = [...w.mem.items.values()].find((x) => x.card.stability > 0)!;
    const last = m.card.last_review!.getTime();
    const S = m.card.stability * w.mem.curve.scale;
    expect(examRecall(m.card, last + 0.5 * S * 86_400_000, w.mem.curve)).toBeCloseTo(recallAt(m.card, last + 0.5 * S * 86_400_000, w.mem.curve), 10);
    const far = last + 5 * S * 86_400_000;
    expect(examRecall(m.card, far, w.mem.curve)).toBeLessThan(recallAt(m.card, far, w.mem.curve));
    expect(examRecall(m.card, far, w.mem.curve)).toBeGreaterThan(Math.pow(0.9, 5) - 1e-9);
  });
});

describe('추천 화면의 문항 수 근거(coach.today)', () => {
  let d: OneQDB;
  beforeEach(() => {
    d = new OneQDB(`v08-${Math.random()}`);
  });
  afterEach(async () => {
    await d.delete();
  });
  it('계획 분 ÷ 문항당 시간 = 목표, 문항당 시간의 근거(실측 수)와 오늘 푼 수', async () => {
    for (const round of [1, 2]) {
      const questions = Array.from({ length: 20 }, (_, i) => ({ hash: `r${round}q${i}`, answer: 1, subjectNo: i < 10 ? 1 : 2 }));
      await importPackBytes(await makePack({ round, questions }), {}, d);
    }
    await savePlanSettings('TEST', { examDate: formatDate(addDays(T0, 30)), dailyMinutes: 30 }, d);
    const c = (await loadCoach('TEST', T0, d))!;
    expect(c.today.target).toBe(20);
    expect(c.today.secPerQuestion).toBe(90);
    expect(c.today.timingObs).toBe(0);
    expect(c.today.done).toBe(0);
  });
});
