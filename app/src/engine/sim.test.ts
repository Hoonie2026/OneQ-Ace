/**
 * 4단계 게이트(개발기준서 6.6): 가상 학습자 3종 × 시험일 60·30·14일 시나리오.
 *
 * 시나리오마다 난수 시드 3개로 돌려 모두 통과해야 한다(운 좋은 한 번이 아니게).
 * 통과 조건
 * 1. 시험일 진짜 점수에서 **과락 과목(40점 미만)이 없다** — 기준서 6.6의 게이트
 * 2. 평균 점수가 비교 기준(같은 시간 동안 회차 순서대로 풀고 틀린 것만 다시)보다 높거나 같다
 * 3. 시험 전날 엔진 예상 평균 점수가 진짜 평균과 ±5점 안
 * 4. 시험일에 평균 60점에 못 미치면, 첫날 계획이 이미 시간 부족을 경고했다
 */
import { describe, expect, it } from 'vitest';
import { LEARNERS, simulate, SUBJECTS } from './sim';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (xs: number[] | null) => (xs ? xs.map((x) => x.toFixed(0).padStart(3)).join(' ') : '-');

// 실행 시간이 30초 남짓이라 평소 `npm test`에서는 건너뛰고 `npm run gate`로 돌린다
describe.runIf(process.env.GATE)('게이트: 가상 학습자 3종 × 시험일 60·30·14일', () => {
  const rows: string[] = [];
  for (const learner of LEARNERS) {
    for (const days of [60, 30, 14]) {
      it.each([1, 2, 3])(`${learner.name} · ${days}일 · 시드 %i`, (seed) => {
        const e = simulate(learner, days, 'engine', seed);
        const s = simulate(learner, days, 'sequential', seed);
        // 참고 상한: 실력을 미리 아는 사람이 가장 약한 과목만 푼 경우(과목 실력이 다른 학습자만)
        const f = new Set(learner.ability).size > 1 ? simulate(learner, days, 'focus', seed) : null;
        rows.push(
          `${learner.name.padEnd(18)} ${String(days).padStart(2)}일 #${seed} | 시작 ${fmt(e.start)} | 엔진 ${fmt(e.final)} 평균 ${mean(e.final).toFixed(1)} (예상 ${mean(e.predictedFinal!).toFixed(1)}) | 회차순 ${fmt(s.final)} 평균 ${mean(s.final).toFixed(1)} | 약한 과목만(참고) ${fmt(f?.final ?? null)} | 부족 경고 ${e.shortageAtStart ? '있음' : '없음'}`,
        );
        // 1. 과락 해소
        for (const [i, x] of e.final.entries()) expect(x, `${SUBJECTS[i]} 과락`).toBeGreaterThanOrEqual(40);
        // 2. 비교 기준보다 평균이 낫다
        expect(mean(e.final)).toBeGreaterThanOrEqual(mean(s.final));
        // 3. 예상 점수 정확도
        expect(Math.abs(mean(e.predictedFinal!) - mean(e.final))).toBeLessThanOrEqual(5);
        // 4. 평균 미달이면 미리 경고
        if (mean(e.final) < 60) expect(e.shortageAtStart).toBe(true);
      }, 120_000);
    }
  }
  it('결과표', () => {
    console.log(`\n과목: ${SUBJECTS.join(' · ')}\n${rows.join('\n')}`);
  });
});
