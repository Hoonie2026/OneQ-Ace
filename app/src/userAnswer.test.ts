import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OneQDB } from './db';
import { importPackBytes } from './pack/import';
import { validatePackZip } from './pack/validate';
import { makePack } from './test/makePack';
import { createSetRun, isCorrect, loadSession, recordAnswer, setUserAnswer } from './study';
import { buildBackup, restoreBackup } from './backup';
import { loadEngine } from './engine/load';

let d: OneQDB;
let n = 0;
beforeEach(() => {
  d = new OneQDB(`ua-${++n}`);
});
afterEach(async () => {
  await d.delete();
});

describe('정답 미지정 문항 — 학습자가 정답 지정(2026-11-17)', () => {
  it('answer null(answer-missing) 문항이 든 팩을 받아들이고, 채점은 정답을 정하기 전까지 틀림', async () => {
    const zip = await makePack({ questions: [{ hash: 'a', answer: null, flags: ['answer-missing'] }, { hash: 'b', answer: 2 }] });
    const r = await validatePackZip(zip);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.questions[0].answer).toBeNull();
      expect(r.questions[0].answerSource).toBe('none');
      expect(isCorrect(r.questions[0], 1)).toBe(false);
    }
  });

  it('지정한 정답은 같은 내용의 다른 회차에도, 이전 풀이 채점에도, 팩을 다시 가져와도 남는다', async () => {
    const q = { hash: 'x', text: '같은 발문 ① 가 ② 나 ③ 다 ④ 라', answer: null, flags: ['answer-missing'] };
    await importPackBytes(await makePack({ round: 1, questions: [q] }), {}, d);
    await importPackBytes(await makePack({ round: 2, questions: [q] }), {}, d);
    const run = await createSetRun('TEST', 'today', 't', ['TEST-2022-1-001'], { now: 1 }, d);
    let s = (await loadSession({ kind: 'set', sessionId: run.sessionId }, d))!;
    ({ session: s } = await recordAnswer(s, (await d.questions.get('TEST-2022-1-001'))!, 3, 1000, { now: 2 }, d));
    expect(s.answers.get('TEST-2022-1-001')!.correct).toBe(false);

    const nq = await setUserAnswer((await d.questions.get('TEST-2022-1-001'))!, 3, d, 10);
    expect(nq.answer).toBe(3);
    expect(nq.flags).toContain('user-answer');
    expect(nq.flags).not.toContain('answer-missing');
    expect((await d.questions.get('TEST-2022-2-001'))!.answer).toBe(3);           // 다른 회차의 같은 문항
    expect((await d.attempts.where('qid').equals('TEST-2022-1-001').first())!.correct).toBe(true);   // 다시 채점

    // 같은 회차를 다시 만들어 가져와도(정답 미지정 그대로) 지정한 정답 유지
    await importPackBytes(await makePack({ round: 1, version: 2, questions: [q] }), { overwrite: true }, d);
    expect((await d.questions.get('TEST-2022-1-001'))!.answer).toBe(3);

    // 백업 → 빈 기기에 팩 가져오기 + 복원해도 유지
    const { data } = await buildBackup('test', d);
    const d2 = new OneQDB(`ua-other-${n}`);
    try {
      await importPackBytes(await makePack({ round: 1, questions: [q] }), {}, d2);
      expect((await d2.questions.get('TEST-2022-1-001'))!.answer).toBeNull();
      await restoreBackup(data, d2);
      expect((await d2.questions.get('TEST-2022-1-001'))!.answer).toBe(3);
    } finally {
      await d2.delete();
    }
  });

  it("'정답 확인 필요' 문항은 정답을 고칠 수 있다", async () => {
    await importPackBytes(await makePack({ questions: [{ hash: 'u', answer: 2, flags: ['answer-unsure'], acceptAlso: [4] }] }), {}, d);
    const nq = await setUserAnswer((await d.questions.get('TEST-2022-1-001'))!, 1, d);
    expect(nq.answer).toBe(1);
    expect(nq.acceptAlso).toEqual([]);
    expect(nq.flags).not.toContain('answer-unsure');
  });
});

describe('같은 학습 단위의 다른 회차 문항(ADR 031)', () => {
  it('글이 보기 순서까지 같으면(번호·띄어쓰기만 다름) 정답을 옮기고, 순서가 다르면 옮기지 않는다', async () => {
    const a = { hash: 'p', text: '5. 레일 이음매 유간 ① 4mm ② 5mm ③ 6mm ④ 7mm', answer: null, flags: ['answer-missing'] };
    const b = { hash: 'q', text: '12.레일 이음매 유간 ①4mm ②5mm ③6mm ④7mm', answer: null, flags: ['answer-missing'] };
    const c = { hash: 'r', text: '9. 레일 이음매 유간 ① 7mm ② 6mm ③ 5mm ④ 4mm', answer: null, flags: ['answer-missing'] };
    await importPackBytes(await makePack({ round: 1, questions: [a] }), {}, d);
    await importPackBytes(await makePack({ round: 2, questions: [b] }), {}, d);
    await importPackBytes(await makePack({ round: 3, questions: [c] }), {}, d);
    await setUserAnswer((await d.questions.get('TEST-2022-1-001'))!, 2, d, 10, ['TEST-2022-2-001', 'TEST-2022-3-001']);
    expect((await d.questions.get('TEST-2022-2-001'))!.answer).toBe(2);
    expect((await d.questions.get('TEST-2022-3-001'))!.answer).toBeNull(); // 순서가 다르면 ②가 다른 보기
    // 옮긴 문항의 정답도 팩을 다시 가져와도 남는다(그 문항 contentHash로도 저장)
    await importPackBytes(await makePack({ round: 2, version: 2, questions: [b] }), { overwrite: true }, d);
    expect((await d.questions.get('TEST-2022-2-001'))!.answer).toBe(2);
  });
});

describe('지정한 정답은 학습 기록을 지워도 유지(2026-11-17)', () => {
  it('wipeRecords·wipeCertRecords 뒤에도 정답·[정답 고치기] 상태 그대로, 모두 지우기(=브라우저 초기화) 뒤에는 처음처럼', async () => {
    const { wipeRecords, wipeCertRecords, wipeAll } = await import('./wipe');
    const q = { hash: 'w', text: '지우기 시험 문항 ① 가 ② 나 ③ 다 ④ 라', answer: null, flags: ['answer-missing'] };
    await importPackBytes(await makePack({ questions: [q] }), {}, d);
    await setUserAnswer((await d.questions.get('TEST-2022-1-001'))!, 4, d);
    await wipeRecords(d);
    await wipeCertRecords('TEST', d);
    const row = (await d.questions.get('TEST-2022-1-001'))!;
    expect(row.answer).toBe(4);
    expect(row.flags).toContain('user-answer');
    await wipeAll(d);
    await importPackBytes(await makePack({ questions: [q] }), {}, d);
    expect((await d.questions.get('TEST-2022-1-001'))!.answer).toBeNull();
  });
});


describe('스캔본 문제팩의 보충 문항(생성기 ADR 032)', () => {
  it('직접 타이핑한 보충 문항(ocr 표시 없음)도 같은 문제팩에 OCR 문항이 있으면 다른 회차의 같은 문항과 묶인다', async () => {
    const ocr = { hash: 'x1', text: '50. 그림의 수평부재 AB는 A지점은 힌지로 지지되고 B점에는 집중하중 Q가 적용하고 있다. 두 기둥의 좌굴에 의해서 붕괴를 일으키는 하중 Q의 크기는?', answer: 2, flags: ['ocr'] };
    const other = { hash: 'x2', text: '3. 다른 스캔 문항으로 레일 이음매 유간의 표준에 대한 설명으로 옳은 것은?', answer: 1, flags: ['ocr'] };
    const typed = { hash: 'x3', text: '49. 그림의 수평부재 AB는 A지점은 힌지로 지지되고 B점에는 집중하중 Q가 작용하고 있다. 두 기둥의 좌굴에 의해서 붕괴를 일으키는 하중 Q의 크기는?', answer: 2 };
    await importPackBytes(await makePack({ round: 1, questions: [ocr] }), {}, d);
    await importPackBytes(await makePack({ round: 2, questions: [other, typed] }), {}, d);
    const ctx = (await loadEngine('TEST', d))!;
    const it = ctx.bank.itemOf.get('TEST-2022-2-002')!;
    expect(it.qids.sort()).toEqual(['TEST-2022-1-001', 'TEST-2022-2-002']);
  });
});
