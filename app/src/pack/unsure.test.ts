import { describe, expect, it } from 'vitest';
import { makePack } from '../test/makePack';
import { validatePackZip } from './validate';

describe('정답 확인 필요·교차 확인 문항(ADR 024)', () => {
  it("flags 'answer-unsure'와 answerSource 'cross-check'가 든 팩을 받아들인다", async () => {
    const zip = await makePack({
      questions: [
        { hash: 'a', flags: ['answer-unsure'], acceptAlso: [3] },
        { hash: 'b', answerSource: 'cross-check' },
      ],
    });
    const r = await validatePackZip(zip);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.questions[0].flags).toContain('answer-unsure');
      expect(r.questions[1].answerSource).toBe('cross-check');
    }
  });
});
