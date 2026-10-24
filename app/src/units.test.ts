import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OneQDB } from './db';
import { importPackBytes } from './pack/import';
import { makePack } from './test/makePack';
import { applyFilters, bundleOrder, groupByLaw, groupByType, groupByUnit, loadSubjectView, pickUnit, startBundle, unitAsk } from './units';
import { recordAnswer, loadSession } from './study';

let d: OneQDB;
let n = 0;
beforeEach(() => {
  d = new OneQDB(`units-${++n}`);
});
afterEach(async () => {
  await d.delete();
});

const UNITS = { 1: [{ id: '1-1', major: '역학', name: '힘과 모멘트' }, { id: '1-2', major: '역학', name: '보의 처짐' }, { id: '2-1', major: '법규', name: '안전관리' }] };

async function load() {
  // 2021·2022 두 회차. "같은" 문항은 두 회차에 같은 글(빈출), 2022에만 단원이 붙음(새 팩) — 2021은 옛 팩(단원 없음)
  await importPackBytes(await makePack({ year: 2021, round: 1, questions: [{ hash: 'a21', text: '같은 문제 ① 1 ② 2 ③ 3 ④ 4' }, { hash: 'b21' }] }), {}, d);
  await importPackBytes(
    await makePack({
      year: 2022,
      round: 1,
      units: UNITS,
      questions: [
        { hash: 'a22', text: '같은 문제 ① 1 ② 2 ③ 3 ④ 4', unit: '1-2', qtype: 'calc' },
        { hash: 'c22', unitCandidates: ['1-1', '2-1'], qtype: 'concept', sequence: true },
        { hash: 'd22', unit: '2-1', qtype: 'law', lawRefs: ['산업안전보건법'] },
      ],
    }),
    {},
    d,
  );
}

describe('단원별·유형별(ADR 021 4절, C3)', () => {
  it('동일 문항 묶음 단위로 단원·유형을 모으고 미정은 따로', async () => {
    await load();
    const v = (await loadSubjectView('TEST', '과목1', d))!;
    expect(v.units.map((u) => u.id)).toEqual(['1-1', '1-2', '2-1']);
    const same = v.items.find((it) => it.qids.length === 2)!;
    expect(same.unit).toBe('1-2'); // 옛 회차 문항도 새 팩의 단원을 따라감
    expect(same.frequent).toBe(true);
    const { groups, undecided } = groupByUnit(v, v.items);
    expect(groups.map((g) => g.major)).toEqual(['역학', '법규']);
    expect(groups[0].units.find((u) => u.def.id === '1-2')!.items).toHaveLength(1);
    expect(undecided.map((it) => it.candidates)).toEqual(expect.arrayContaining([['1-1', '2-1']]));
    const types = groupByType(v.items);
    expect([types.calc.length, types.law.length]).toEqual([1, 1]);
    expect(groupByLaw(types.law)[0].law).toBe('산업안전보건법');
    expect(applyFilters(v.items, new Set(['sequence'])).length).toBe(1);
    expect(applyFilters(v.items, new Set(['frequent'])).length).toBe(1);
  });

  it('미정 문항: 답한 뒤 후보에서 고르면 그 단원으로 옮겨 가고 다시 묻지 않음', async () => {
    await load();
    const q = (await d.questions.get('TEST-2022-1-002'))!;
    const ask = (await unitAsk('TEST', q, d))!;
    expect(ask.options.map((o) => o.name)).toEqual(['힘과 모멘트', '안전관리']);
    expect(await unitAsk('TEST', (await d.questions.get('TEST-2022-1-001'))!, d)).toBeNull(); // 단원이 정해진 문항은 묻지 않음
    await pickUnit('TEST', ask.itemKey, '1-1', d);
    expect(await unitAsk('TEST', q, d)).toBeNull();
    const v = (await loadSubjectView('TEST', '과목1', d))!;
    const it = v.items.find((x) => x.qid === 'TEST-2022-1-002')!;
    expect([it.unit, it.picked]).toEqual(['1-1', true]);
  });

  it('묶음 학습: 안 푼 → 자주 틀린 → 나머지 순, 끝나면 섞어 풀기 안내용 표시', async () => {
    await load();
    const v = (await loadSubjectView('TEST', '과목1', d))!;
    const t = (await startBundle('TEST', '과목1', '과목1 · 보의 처짐', v.items, Date.now(), d))!;
    const s = (await loadSession(t, d))!;
    expect(s.run.bundle).toBe('과목1 · 보의 처짐');
    // 하나 틀리면 그 문항은 "자주 틀린 것" 필터에 잡힘
    const q = (await d.questions.get(s.qids[0]))!;
    await recordAnswer(s, q, q.answer === 1 ? 2 : 1, 1000, {}, d);
    const v2 = (await loadSubjectView('TEST', '과목1', d))!;
    expect(applyFilters(v2.items, new Set(['wrong'])).map((x) => x.qid)).toContain(q.qid);
    expect(bundleOrder(v2.items)[0].solved).toBe(0);
  });
});
