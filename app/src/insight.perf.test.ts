import { it } from 'vitest';
import { buildBank, replay, rng, DEFAULT_PLAN_SETTINGS, engineForecast, engineOutlook, type EngineAttempt } from './engine';
import { syntheticBank } from './engine/sim';
import { buildConcepts } from './engine/similar';
import { addDays, formatDate } from './engine/days';
import { examViews, type Coach } from './coach';
import { computeInsight } from './insight';

it.runIf(process.env.PERF)('insight perf', () => {
  const qs = syntheticBank(31);
  const text = new Map(qs.map((q) => [q.qid, q.text]));
  const bank = buildBank(qs);
  const c = buildConcepts(bank, (q) => text.get(q) ?? '');
  bank.concepts = c.concepts;
  bank.shares = c.shares;
  const r = rng(3);
  const T0 = new Date(2026, 9, 1, 9).getTime();
  const attempts: EngineAttempt[] = [];
  let k = 0;
  for (let d = 0; d < 20; d++) for (let i = 0; i < 40; i++) {
    const it = bank.items[(k++ * 7) % bank.items.length];
    attempts.push({ qid: it.qids[0], ts: addDays(T0, d) + i * 60000, correct: r() < 0.6, chosen: 1, elapsedMs: 60000 + r() * 60000 });
  }
  const now = addDays(T0, 20);
  const mem = replay(bank, attempts);
  const settings = { ...DEFAULT_PLAN_SETTINGS, examDate: formatDate(addDays(T0, 80)), dailyMinutes: 90, studyDaysPerWeek: 6, dayMinutes: {} };
  const ctx = { certCode: 'X', bank, mem, attempts, settings };
  let t = performance.now();
  const o = engineOutlook(ctx, now);
  console.log('outlook ms', performance.now() - t);
  t = performance.now();
  const v = examViews(ctx, engineForecast(ctx), o, now);
  console.log('examViews ms', performance.now() - t);
  const coach = { ctx, subjects: v.subjects, exam: v.exam, settings } as unknown as Coach;
  t = performance.now();
  const ins = computeInsight(coach, now);
  console.log('insight ms', performance.now() - t, JSON.stringify({ ...ins, plan: ins.plan && { avg: ins.plan.avg, chance: ins.plan.chance }, atPace: ins.atPace && { avg: ins.atPace.avg, chance: ins.atPace.chance } }));
});
