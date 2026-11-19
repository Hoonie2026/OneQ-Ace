// 실험(ADR 014): 앱 추천 묶음 규칙 변형 비교. EXP=1 npx vitest run src/engine/exp.test.ts
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { dailyOpts, LEARNERS, passProbability, simulate, type SimOptions } from './sim';
import { parseDate } from './days';


const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const VARIANTS: Record<string, SimOptions['daily']> = {
  /** 과목 진단 + 직전 총정리, 새 문항은 순서대로(한 과목 몰기) */
  order: (_b, _m, s) => ({ examDay: parseDate(s.examDate) }),
  /** + 새 문항 합격 확률 기여도 비례 배분(앱 v0.8 기본) */
  weight: (b, m, s) => dailyOpts(b, m, s),
};
const only = process.env.VARS?.split(',');
describe.runIf(process.env.EXP)('exp', () => {
  it('variants', () => {
    const out: Record<string, unknown>[] = [];
    for (const response of (process.env.RESP ? [process.env.RESP] : ['crisis', 'fixed']) as ('crisis' | 'fixed')[])
      for (const [li, learner] of LEARNERS.entries()) if (!process.env.LI || process.env.LI === String(li))
        for (const days of [60, 30, 14])
          for (const seed of [1, 2, 3]) {
            const e = process.env.SELF ? null : simulate(learner, days, { seed, response });
            const row: Record<string, unknown> = { response, li, days, seed, e: e ? [passProbability(e.final), mean(e.final), mean(e.predictedFinal!) - mean(e.final), Math.min(...e.final)] : [0, 0, 0, 0] };
            for (const [name, fn] of Object.entries(VARIANTS)) {
              if (only && !only.includes(name)) continue;
              const a = process.env.SELF ? simulate(learner, days, { policy: 'daily', seed, response, daily: fn }) : simulate(learner, days, { policy: 'daily', seed, minutesByDay: e!.minutesByDay, daily: fn });
              row[name] = [passProbability(a.final), mean(a.final), mean(a.predictedFinal!) - mean(a.final), Math.min(...a.final)];
            }
            out.push(row);
            writeFileSync(process.env.OUT!, JSON.stringify(out));
          }
  }, 3_600_000);
});
