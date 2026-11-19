import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OneQDB } from './db';
import { importPackBytes } from './pack/import';
import { makePack } from './test/makePack';
import { engineMock, loadEngine } from './engine/load';

let d: OneQDB;
let n = 0;
beforeEach(() => {
  d = new OneQDB(`v10-${++n}`);
});
afterEach(async () => {
  await d.delete();
});

describe('v0.10.6 옛 기준 과목을 합친 팩(ADR 016)', () => {
  // 건설안전기사: 2025년까지 6과목 120문항 → 2026 기준 5과목 100문항. 옛 두 과목을 합친 1과목은 회차당 40문항, 실제 시험은 20문항
  const merged = (round: number) =>
    Array.from({ length: 60 }, (_, i) => ({ hash: `m${round}q${i}`, answer: 1, subjectNo: i < 40 ? 1 : 2 }));

  it('모의고사는 팩의 문항 수(40)가 아니라 실제 시험 문항 수(examCount 20)만큼 뽑는다', async () => {
    for (const round of [1, 2]) {
      await importPackBytes(await makePack({ year: 2020 + round, round, questions: merged(round), examCount: { 1: 20 } }), {}, d);
    }
    const ctx = (await loadEngine('TEST', d))!;
    const s1 = ctx.bank.subjects.find((s) => s.name === '과목1')!;
    expect(s1.examCount).toBe(20);
    expect(ctx.bank.subjects.find((s) => s.name === '과목2')!.examCount).toBe(20);
    const mock = engineMock(ctx, 7);
    expect(mock.bySubject.map((s) => s.qids.length)).toEqual([20, 20]);
    expect(mock.qids.length).toBe(40);
  });

  it('examCount가 없는 팩은 지금처럼 팩의 문항 수를 쓴다', async () => {
    await importPackBytes(await makePack({ questions: merged(1) }), {}, d);
    const ctx = (await loadEngine('TEST', d))!;
    expect(ctx.bank.subjects.find((s) => s.name === '과목1')!.examCount).toBe(40);
  });
});
