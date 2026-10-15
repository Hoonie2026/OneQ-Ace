import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMinutes, fmtMinutes, loadCoach, mockHistory, startMock, startRetry, startToday } from './coach';
import { OneQDB } from './db';
import { loadPlanSettings, savePlanSettings } from './engine';
import { importPackBytes } from './pack/import';
import { finishRun, firstUnanswered, loadSession, packSummary, recordAnswer, sessionResult, type Target } from './study';
import { deleteCert } from './wipe';
import { makePack } from './test/makePack';

let d: OneQDB;
let n = 0;
beforeEach(() => {
  d = new OneQDB(`c${++n}`);
});
afterEach(async () => {
  await d.delete();
});

const NOW = new Date(2027, 0, 4, 9).getTime(); // 월요일 9시

/** 2개 회차 × 과목 2개 × 10문항 */
async function twoRounds() {
  for (const round of [1, 2]) {
    const questions = Array.from({ length: 20 }, (_, i) => ({ hash: `r${round}q${i}`, answer: 1, subjectNo: i < 10 ? 1 : 2 }));
    await importPackBytes(await makePack({ round, questions }), {}, d);
  }
}

async function solveSet(t: Target, pick: (i: number) => number, count = Infinity) {
  let s = (await loadSession(t, d))!;
  for (let k = 0; k < count; k++) {
    const i = firstUnanswered(s);
    if (i < 0) break;
    const q = (await d.questions.get(s.qids[i]))!;
    ({ session: s } = await recordAnswer(s, q, pick(i), 60_000, { now: NOW + k * 1000 }, d));
  }
  return s;
}

describe('홈 대시보드·오늘 학습(5단계)', () => {
  it('시험일이 없으면 계획 없음, 정하면 D-day·예상 점수·합격 기준 경고·오늘 학습량', async () => {
    await twoRounds();
    let c = (await loadCoach('TEST', NOW, d))!;
    expect(c.settings).toBeNull();
    expect(c.plan).toBeNull();
    expect(await startToday('TEST', NOW, d)).toBeNull();

    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 30 }, d);
    c = (await loadCoach('TEST', NOW, d))!;
    expect(c.plan!.daysLeft).toBe(14);
    expect(c.plan!.todayTarget).toBe(20); // 30분 ÷ 1.5분
    expect(c.forecast!.subjects).toHaveLength(2);
    expect(c.outlook!.status).toBe('unknown'); // 과목 진단 전
    expect(c.doneToday).toBe(0);
  });

  it('오늘 학습: 15문항 묶음, 회독 진도에는 안 들어가고, 틀린 것만 다시 풀 수 있다', async () => {
    await twoRounds();
    await savePlanSettings('TEST', { examDate: '2027-01-18' }, d);
    const t = (await startToday('TEST', NOW, d))!;
    expect(t.kind).toBe('set');
    let s = (await loadSession(t, d))!;
    expect(s.qids).toHaveLength(15);
    s = await solveSet(t, (i) => (i % 3 === 0 ? 2 : 1));
    expect(s.run.finishedAt).not.toBeNull();
    const r = await sessionResult(s, d);
    expect(r.complete).toBe(true);
    expect(r.verdict).toBeNull(); // 오늘 학습은 합격 판정 없음
    expect(r.subjects.map((x) => x.name)).toEqual(['과목1', '과목2']); // 회차가 달라도 과목명으로 묶음
    expect(r.wrongQids).toHaveLength(5);
    // 회독 진도는 그대로 0
    const sum = await packSummary((await d.packs.get('TEST-2022-1'))!, d);
    expect(sum.answered).toBe(0);
    // 틀린 문항 다시
    const retry = (await startRetry('TEST', r.wrongQids, NOW + 3_600_000, d))!;
    expect((await loadSession(retry, d))!.qids).toEqual(r.wrongQids);
    // 홈: 오늘 푼 수, 끝난 묶음은 이어 풀기 없음, 재출제 묶음은 이어 풀기
    const c = (await loadCoach('TEST', NOW + 3_600_000, d))!;
    expect(c.doneToday).toBe(15);
    expect(c.openToday!.left).toBe(5);
  });

  it('합격 기준 경고의 권장 시간 적용: 오늘부터 시험 전날까지, 더 길게 정한 날은 그대로', async () => {
    await twoRounds();
    await savePlanSettings('TEST', { examDate: '2027-01-08', dayMinutes: { '2027-01-06': 300 } }, d);
    const s = (await loadPlanSettings('TEST', d))!;
    await applyMinutes('TEST', s, 120, NOW, d);
    const after = (await loadPlanSettings('TEST', d))!;
    expect(after.dayMinutes).toEqual({ '2027-01-04': 120, '2027-01-05': 120, '2027-01-06': 300, '2027-01-07': 120 });
    expect(fmtMinutes(150)).toBe('2시간 30분');
    expect(fmtMinutes(45)).toBe('45분');
  });
});

describe('모의고사(5단계)', () => {
  it('현행 과목별 문항 수만큼 출제, 제출하면 안 푼 문항 0점으로 채점·판정, 성적 이력', async () => {
    await twoRounds();
    const t = (await startMock('TEST', NOW, d))!;
    let s = (await loadSession(t, d))!;
    expect(s.qids).toHaveLength(20); // 최근 회차 과목별 10문항씩
    expect(s.run.limitSec).toBe(30 * 60);
    s = await solveSet(t, () => 1, 12); // 12문항만 맞히고
    expect(s.run.finishedAt).toBeNull();
    await finishRun(s.run.sessionId, NOW + 600_000, d); // 제출
    const done = (await loadSession(t, d))!;
    const r = await sessionResult(done, d);
    expect(r.answered).toBe(12);
    expect(r.verdict).not.toBeNull();
    expect(r.avgScore).toBe(60);
    const h = await mockHistory('TEST', d);
    expect(h).toHaveLength(1);
    expect(h[0].finished).toBe(true);
    expect(h[0].result.avgScore).toBe(60);
  });

  it('자격종목을 지우면 오늘 학습·모의고사 묶음도 함께 지운다', async () => {
    await twoRounds();
    await savePlanSettings('TEST', { examDate: '2027-01-18' }, d);
    await startToday('TEST', NOW, d);
    await startMock('TEST', NOW, d);
    expect(await d.runs.count()).toBe(2);
    await deleteCert('TEST', d);
    expect(await d.runs.count()).toBe(0);
  });
});
