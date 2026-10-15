import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OneQDB } from './db';
import { deletePack, importPackBytes } from './pack/import';
import { ensureWrongRun, firstUnanswered, loadSession, recordAnswer, restartPass, saveNote, sessionResult, setUnsure, type Target } from './study';
import { backupDue, buildBackup, fingerprint, parseBackup, restoreBackup, BackupFormatError } from './backup';
import { makePack, type FakeQ } from './test/makePack';

let d: OneQDB;
let n = 0;
beforeEach(() => {
  d = new OneQDB(`t${++n}`);
});
afterEach(async () => {
  await d.delete();
});

const qs = (seeds: string[], answer = 1): FakeQ[] => seeds.map((hash, i) => ({ hash, answer, subjectNo: i < 2 ? 1 : 2 }));

async function solve(target: Target, pick: (i: number) => number, count = Infinity, dd = d) {
  let s = (await loadSession(target, dd))!;
  for (let n = 0; n < count; n++) {
    const i = firstUnanswered(s);
    if (i < 0) break;
    const q = (await dd.questions.get(s.qids[i]))!;
    ({ session: s } = await recordAnswer(s, q, pick(i), 1000 + i, {}, dd));
  }
  return s;
}
const solveAll = (packId: string, pick: (i: number) => number, dd = d) => solve({ kind: 'pass', packId }, pick, Infinity, dd);

describe('팩 가져오기', () => {
  it('검증 실패 팩은 저장하지 않는다', async () => {
    const r = await importPackBytes(new Uint8Array([1, 2, 3]), {}, d);
    expect(r.status).toBe('invalid');
    expect(await d.packs.count()).toBe(0);
  });

  it('정상 팩 저장, 같은 버전은 건너뛰고 낮은 버전은 거부', async () => {
    const v1 = await makePack({ questions: qs(['a', 'b', 'c']) });
    expect((await importPackBytes(v1, {}, d)).status).toBe('imported');
    expect(await d.questions.count()).toBe(3);
    expect(await d.images.count()).toBe(3);
    expect((await importPackBytes(v1, {}, d)).status).toBe('same');
    const v2 = await makePack({ version: 2, questions: qs(['a', 'b', 'c']) });
    expect((await importPackBytes(v2, {}, d)).status).toBe('imported');
    expect((await importPackBytes(v1, {}, d)).status).toBe('older');
    expect((await d.packs.get('TEST-2022-1'))!.packVersion).toBe(2);
  });
});

describe('채점·결과', () => {
  it('모름은 chosen 0·오답, 과목별 점수와 합격 판정', async () => {
    await importPackBytes(await makePack({ questions: qs(['a', 'b', 'c', 'd'], 2) }), {}, d);
    // 1과목: 2문항 모두 정답, 2과목: 1 오답 + 1 모름
    const run = await solveAll('TEST-2022-1', (i) => [2, 2, 3, 0][i]);
    const r = await sessionResult(run, d);
    expect([r.correct, r.wrong, r.unknown]).toEqual([2, 1, 1]);
    expect(r.subjects.map((s) => s.score)).toEqual([100, 0]);
    expect(r.complete).toBe(true);
    expect(r.verdict).toBe('fail-subject');
    const atts = await d.attempts.toArray();
    expect(atts.find((a) => a.chosen === 0)!.correct).toBe(false);
  });

  it('오답·모름 다시 풀기는 가장 최근 풀이가 틀린 문항만', async () => {
    await importPackBytes(await makePack({ questions: qs(['a', 'b', 'c']) }), {}, d);
    await solveAll('TEST-2022-1', (i) => [1, 2, 0][i]);
    const w = (await ensureWrongRun('TEST-2022-1', d))!;
    expect(w.qids).toEqual(['TEST-2022-1-002', 'TEST-2022-1-003']);
    // 하나만 풀고 나가면 같은 묶음을 이어 푼다
    await solve({ kind: 'wrong', sessionId: w.sessionId }, () => 1, 1);
    const again = (await ensureWrongRun('TEST-2022-1', d))!;
    expect(again.sessionId).toBe(w.sessionId);
    const ws = (await loadSession({ kind: 'wrong', sessionId: w.sessionId }, d))!;
    expect(firstUnanswered(ws)).toBe(1);
    // 오답 풀이는 회독 진도에 섞이지 않는다
    const p = (await loadSession({ kind: 'pass', packId: 'TEST-2022-1' }, d))!;
    expect(p.answers.get('TEST-2022-1-002')!.mode).toBe('round');
  });
});

describe('회독·이어 풀기 (ADR 003, 실기기 S3·S6 NG 회귀)', () => {
  const PID = 'TEST-2022-1';
  const six = () => makePack({ questions: ['a', 'b', 'c', 'd', 'e', 'f'].map((h, i) => ({ hash: h, subjectNo: i < 3 ? 1 : 2 })) });

  it('과목별로 푼 것도 회차 진도에 쌓이고, 과목을 오가도 초기화되지 않는다', async () => {
    await importPackBytes(await six(), {}, d);
    await solve({ kind: 'pass', packId: PID }, () => 1, 2); // 회차: 1·2번
    await solve({ kind: 'pass', packId: PID, subjectNo: 2 }, () => 1, 2); // 2과목: 4·5번
    await solve({ kind: 'pass', packId: PID, subjectNo: 1 }, () => 1, 0); // 1과목 열었다 닫기
    const s2 = (await loadSession({ kind: 'pass', packId: PID, subjectNo: 2 }, d))!;
    expect(s2.qids[firstUnanswered(s2)]).toBe(`${PID}-006`); // 2과목은 6번부터
    const all = (await loadSession({ kind: 'pass', packId: PID }, d))!;
    expect(all.answers.size).toBe(4);
    expect(all.qids[firstUnanswered(all)]).toBe(`${PID}-003`); // 회차 전체는 3번부터
    expect(await d.runs.filter((r) => r.mode === 'round').count()).toBe(1);
  });

  it('다 풀기 전에도 성적이 나온다(푼 문항 정답률)', async () => {
    await importPackBytes(await six(), {}, d);
    const s = await solve({ kind: 'pass', packId: PID }, (i) => (i === 0 ? 1 : 2), 2);
    const r = await sessionResult(s, d);
    expect([r.answered, r.correct, r.complete]).toEqual([2, 1, false]);
    expect(r.subjects[0].rate).toBe(50);
    expect(r.subjects[1].rate).toBe(null);
    expect(r.verdict).toBe(null); // 과목마다 5문항 이상 풀기 전에는 판정하지 않음
  });

  it('새 회독은 처음부터, 이전 기록은 원장에 남는다', async () => {
    await importPackBytes(await six(), {}, d);
    await solveAll(PID, () => 1);
    await restartPass(PID, d);
    const s = (await loadSession({ kind: 'pass', packId: PID }, d))!;
    expect(s.answers.size).toBe(0);
    expect(await d.attempts.count()).toBe(6);
  });

  it('첫 회독은 회독이 생기기 전에 푼 기록도 포함한다(v0.1.0 데이터 이어받기)', async () => {
    await importPackBytes(await six(), {}, d);
    const q = (await d.questions.get(`${PID}-002`))!;
    await d.attempts.add({ uid: 'old', qid: q.qid, contentHash: q.contentHash, ts: 5, chosen: 1, correct: true, unsure: false, elapsedMs: 1, mode: 'subject', sessionId: 'old-run' });
    const s = (await loadSession({ kind: 'pass', packId: PID }, d))!;
    expect(s.answers.has(q.qid)).toBe(true);
    expect(firstUnanswered(s)).toBe(0);
  });
});

describe('같은 팩 다시 가져오기', () => {
  it('내용까지 같으면 identical, 기록은 그대로', async () => {
    const pack = await makePack({ questions: qs(['a', 'b']) });
    await importPackBytes(pack, {}, d);
    await solveAll('TEST-2022-1', () => 1);
    const r = await importPackBytes(pack, {}, d);
    expect(r.status === 'same' && r.identical).toBe(true);
    const other = await makePack({ questions: qs(['a', 'z']) });
    const r2 = await importPackBytes(other, {}, d);
    expect(r2.status === 'same' && !r2.identical).toBe(true);
    expect(await d.attempts.count()).toBe(2);
  });
});

describe('재연결(ADR 002)', () => {
  it('재전처리로 번호가 바뀌면 같은 팩 안에서 contentHash로 기록을 옮긴다', async () => {
    await importPackBytes(await makePack({ questions: qs(['a', 'b', 'c']) }), {}, d);
    await solveAll('TEST-2022-1', () => 1);
    // v2: 순서 바뀜 + c 내용 수정(c2) + 새 문항 x
    const r = await importPackBytes(await makePack({ version: 2, questions: qs(['b', 'a', 'c2', 'x']) }), {}, d);
    if (r.status !== 'imported') throw new Error(r.status);
    expect(r.reconcile.moved).toBe(2); // a·b 번호 이동
    expect(r.reconcile.corrected).toBe(1); // 003은 qid 유지·내용 수정
    expect(r.reconcile.pending).toBe(0);
    const byQid = new Map((await d.attempts.toArray()).map((a) => [a.qid, a]));
    expect(byQid.get('TEST-2022-1-002')!.contentHash).toBe((await d.questions.get('TEST-2022-1-002'))!.contentHash);
  });

  it('다른 회차에 같은 문항이 있어도 기록을 그쪽으로 붙이지 않는다', async () => {
    await importPackBytes(await makePack({ round: 1, questions: qs(['same', 'b']) }), {}, d);
    await solveAll('TEST-2022-1', () => 1);
    await importPackBytes(await makePack({ round: 2, questions: qs(['same', 'z']) }), {}, d);
    await deletePack('TEST-2022-1', d);
    expect(await d.attempts.count()).toBe(0);
    expect(await d.orphans.count()).toBe(2);
    // 다시 가져오면 매핑 대기에서 되살아난다
    const r = await importPackBytes(await makePack({ round: 1, questions: qs(['same', 'b']) }), {}, d);
    if (r.status !== 'imported') throw new Error(r.status);
    expect(r.reconcile.restored).toBe(2);
    expect(await d.orphans.count()).toBe(0);
    expect((await d.attempts.toArray()).every((a) => a.qid.startsWith('TEST-2022-1-'))).toBe(true);
  });
});

describe('백업·복원 (3단계 게이트: 백업 → 앱 삭제 → 복원 후 100% 일치)', () => {
  it('빈 기기에 복원하면 지문이 같고, 팩을 다시 가져오면 매핑 대기가 0', async () => {
    const pack = await makePack({ questions: qs(['a', 'b', 'c', 'd']) });
    await importPackBytes(pack, {}, d);
    const run = await solveAll('TEST-2022-1', (i) => [1, 2, 0, 1][i]);
    await setUnsure(run.answers.get('TEST-2022-1-001')!.uid, true, d);
    await saveNote((await d.questions.get('TEST-2022-1-002'))!, '측지위도와 천문위도 차이', d);
    const fp = await fingerprint(d);
    const { json } = await buildBackup('test', d);

    await d.delete(); // 앱 삭제
    const fresh = new OneQDB(`t${++n}`);
    try {
      // 팩보다 백업을 먼저 복원해도(팩 없음) 기록은 매핑 대기로 보존된다
      const rep = await restoreBackup(parseBackup(json), fresh);
      expect(rep.matchesBackup).toBe(true);
      expect(rep.after).toEqual(fp);
      expect(rep.missingPacks.map((p) => p.packId)).toEqual(['TEST-2022-1']);
      expect(await fresh.attempts.count()).toBe(0);

      const r = await importPackBytes(pack, {}, fresh);
      if (r.status !== 'imported') throw new Error(r.status);
      expect(r.reconcile.pending).toBe(0);
      expect(await fingerprint(fresh)).toEqual(fp);
      expect((await fresh.notes.get('TEST-2022-1-002'))!.text).toBe('측지위도와 천문위도 차이');
      // 회독(runs)도 돌아와 같은 진도·성적
      const back = (await loadSession({ kind: 'pass', packId: 'TEST-2022-1' }, fresh))!;
      expect(back.run.sessionId).toBe(run.run.sessionId);
      expect(back.answers.size).toBe(4);
      expect((await sessionResult(back, fresh)).correct).toBe(2);
    } finally {
      await fresh.delete();
    }
  });

  it('같은 백업을 두 번 복원해도 기록이 늘지 않는다', async () => {
    await importPackBytes(await makePack({ questions: qs(['a', 'b']) }), {}, d);
    await solveAll('TEST-2022-1', () => 1);
    const { json } = await buildBackup('test', d);
    const rep = await restoreBackup(parseBackup(json), d);
    expect(rep.added).toBe(0);
    expect(rep.skipped).toBe(2);
    expect(rep.matchesBackup).toBe(true);
    expect(await d.attempts.count()).toBe(2);
  });

  it('0단계 시험 백업·다른 파일은 거부', () => {
    expect(() => parseBackup('{"format":"oneq-backup","formatVersion":0}')).toThrow(BackupFormatError);
    expect(() => parseBackup('hello')).toThrow(BackupFormatError);
    expect(() => parseBackup('﻿{"format":"x"}')).toThrow('원큐합격 백업 파일이 아닙니다');
  });

  it('백업 권유: 300건 또는 7일', async () => {
    await importPackBytes(await makePack({ questions: qs(['a']) }), {}, d);
    expect((await backupDue(Date.now(), d)).due).toBe(false);
    await solveAll('TEST-2022-1', () => 1);
    expect((await backupDue(Date.now(), d)).due).toBe(false);
    expect((await backupDue(Date.now() + 8 * 86400_000, d)).due).toBe(true);
  });
});
