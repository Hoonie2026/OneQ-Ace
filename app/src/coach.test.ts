import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMinutes, daySummary, startRelearn, fmtMinutes, loadCoach, mockHistory, questionHistory, startMock, startSubject, startToday } from './coach';
import { pauseRun, resumeRun, deadlineOf } from './study';
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
    expect(c.order).toHaveLength(2); // 계획 없이도 오늘 학습은 된다

    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 30 }, d);
    c = (await loadCoach('TEST', NOW, d))!;
    expect(c.plan!.daysLeft).toBe(14);
    expect(c.plan!.todayTarget).toBe(20); // 30분 ÷ 1.5분
    expect(c.forecast!.subjects).toHaveLength(2);
    expect(c.outlook!.status).toBe('unknown'); // 과목 진단 전
    expect(c.doneToday).toBe(0);
  });

  it('오늘 학습: 오늘 계획량 전체를 한 묶음으로(22.5분 = 15문항), 회독 진도와 별개, 틀린 문항은 바로 한 번 더·다음 묶음 맨 앞', async () => {
    await twoRounds();
    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 22.5 }, d);
    const pre = (await loadCoach('TEST', NOW, d))!;
    expect([pre.today.target, pre.today.size, pre.today.extra]).toEqual([15, 15, false]);
    expect(pre.today.bySubject.reduce((t, b) => t + b.review + b.fresh, 0)).toBe(15);
    const t = (await startToday('TEST', NOW, d))!;
    expect(t.kind).toBe('set');
    let s = (await loadSession(t, d))!;
    expect(s.qids).toHaveLength(15);
    s = await solveSet(t, (i) => (i % 3 === 0 ? 2 : 1));
    expect(s.run.finishedAt).not.toBeNull();
    const r = await sessionResult(s, d);
    expect(r.complete).toBe(true);
    expect(r.verdict).toBeNull(); // 오늘 학습은 합격 판정 없음
    // 처음엔 과목 진단(ADR 014): 진단이 덜 된 두 과목을 번갈아(과목마다 10문항까지) — 회차가 달라도 과목명으로 묶음
    expect(r.subjects.map((x) => x.name).sort()).toEqual(['과목1', '과목2']);
    const subj = await Promise.all(s.qids.slice(0, 4).map(async (q) => (await d.questions.get(q))!.subjectNo));
    expect(subj[0]).not.toBe(subj[1]); // 번갈아
    expect(r.wrongQids).toHaveLength(5);
    // 회독 진도는 그대로 0
    const sum = await packSummary((await d.packs.get('TEST-2022-1'))!, d);
    expect(sum.answered).toBe(0);
    // 묶음 끝 "틀린 문항 한 번 더"
    const rl = (await startRelearn('TEST', r.wrongQids, NOW + 1_800_000, d))!;
    const rls = (await loadSession(rl, d))!;
    expect(rls.qids).toEqual(r.wrongQids);
    expect(rls.run.relearn).toBe(true);
    await d.runs.delete(rls.run.sessionId);
    // 계획량을 다 했으면 추가 15문항: 틀린 5문항이 맨 앞, 오늘 맞힌 10문항은 내일부터
    const t2 = (await startToday('TEST', NOW + 3_600_000, d))!;
    const s2 = (await loadSession(t2, d))!;
    expect(s2.qids.slice(0, 5).sort()).toEqual([...r.wrongQids].sort());
    expect(s2.qids.some((q) => s.qids.includes(q) && !r.wrongQids.includes(q))).toBe(false);
    // 홈: 오늘 푼 수(v0.11 — "이어서 학습" 없음, 새 묶음을 시작하면 전 묶음은 닫힌다)
    const c = (await loadCoach('TEST', NOW + 3_600_000, d))!;
    expect(c.doneToday).toBe(15);
    const t3 = (await startToday('TEST', NOW + 3_600_001, d))!;
    expect((await d.runs.get((t2 as { sessionId: string }).sessionId))!.finishedAt).toBe(NOW + 3_600_001);
    expect((await d.runs.get((t3 as { sessionId: string }).sessionId))!.finishedAt).toBeFalsy();
    // 오늘 학습 기록(현재 점수 = 푼 15문항 중 정답 10)
    const sum2 = (await daySummary('TEST', NOW + 3_600_000, d))!;
    expect([sum2.answered, sum2.correct]).toEqual([15, 10]);
    expect([sum2.currentSolved, sum2.currentCorrect, sum2.current]).toEqual([15, 10, 66.7]);
    // v0.11.1: 목표·남은 문항, 과목은 전부(오늘 안 푼 과목도 0/0으로)
    expect([sum2.target, sum2.left, sum2.wrong + sum2.unknown]).toEqual([15, 0, 5]);
    expect(sum2.bySubject.map((b) => b.name).sort()).toEqual(['과목1', '과목2']);
    // v0.11.2: 과목별 목표 = 푼 수 + 남은 배정(목표를 다 채웠으면 푼 수 그대로)
    expect(sum2.bySubject.reduce((t, b) => t + b.goal, 0)).toBe(15);
    expect(sum2.bySubject.every((b) => b.goal === b.answered)).toBe(true);
    expect(sum2.projectedAvg).not.toBeNull();
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
    // ✕로 멈췄다가 10분 뒤 이어서 → 마감이 10분 늦춰짐(실기기 v0.3.0 Q6)
    const before = deadlineOf(s.run)!;
    await pauseRun(s.run.sessionId, NOW + 60_000, d);
    const resumed = await resumeRun((await d.runs.get(s.run.sessionId))!, NOW + 660_000, d);
    expect(deadlineOf(resumed)! - before).toBe(600_000);
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

describe('과목별 학습·실제 시험 기준 예상(ADR 008)', () => {
  /** 2회차, 2회차의 첫 문항은 1회차 첫 문항과 같은 내용 */
  async function withRepeat() {
    for (const round of [1, 2]) {
      const questions = Array.from({ length: 20 }, (_, i) => ({ hash: round === 2 && i === 0 ? 'r1q0' : `r${round}q${i}`, answer: 1, subjectNo: i < 10 ? 1 : 2 }));
      await importPackBytes(await makePack({ year: 2020 + round, round, questions }), {}, d);
    }
  }

  it('과목 학습: 그 과목만, 출제빈도 높은 문항 먼저, 오늘 푼 문항은 다시 내지 않음', async () => {
    await withRepeat();
    // 과목 학습 한 묶음 = 오늘 남은 목표 문항 수(v0.7.2): 22.5분 ÷ 1.5분 = 15문항
    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 22.5 }, d);
    const c = (await loadCoach('TEST', NOW, d))!;
    const k1 = c.subjects[0].key;
    const t = (await startSubject('TEST', k1, NOW, d))!;
    let s = (await loadSession(t, d))!;
    expect(s.qids).toHaveLength(15); // 과목1: 2회차 × 10문항 − 같은 문항 1 = 19 학습 단위
    const qs = await d.questions.bulkGet(s.qids);
    expect(qs.every((q) => q!.subjectNo === 1)).toBe(true);
    expect(s.qids[0]).toBe('TEST-2022-2-001'); // 2022년 2회 // 2회 출제 문항이 맨 앞(최근 회차 문항으로)
    s = await solveSet(t, (i) => (i < 10 ? 1 : 2)); // 10 맞힘, 5 틀림
    const t2 = (await startSubject('TEST', k1, NOW + 60_000, d))!;
    const s2 = (await loadSession(t2, d))!;
    expect(s2.qids).toHaveLength(9); // 오늘 틀린 5(다시) + 남은 새 문항 4, 오늘 맞힌 10은 내일부터
    expect(s2.qids.slice(0, 5)).toEqual(s.qids.slice(10)); // 틀린 순서대로 먼저
    // 모의고사로 푼 문항은 "오늘 끝"이 아니다(실기기 v0.3.0 Q3): 모의고사만 푼 날에도 과목 학습이 비지 않음
    const mockT = (await startMock('TEST', NOW + 120_000, d))!;
    await solveSet(mockT, () => 1);
    const c2 = (await loadCoach('TEST', NOW + 180_000, d))!;
    const s1v = c2.subjects.find((x) => x.key === k1)!;
    expect(s1v.avail.relearn).toBe(5);
    expect(await startSubject('TEST', k1, NOW + 180_000, d)).not.toBeNull();
    // 출제 이력
    const h = await questionHistory('TEST', d);
    expect(h.get('TEST-2022-2-001')).toEqual(['2022년 2회', '2021년 1회']);
    expect(h.get('TEST-2021-1-005')).toEqual(['2021년 1회']);
  });

  it('현재 점수는 기록 그대로(모름 0점), 예상은 실제 시험 기준(반복 출제 비율 + 처음 보는 문항 정답률, 모름은 25%)', async () => {
    await withRepeat();
    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 22.5 }, d); // 한 묶음 15문항
    const k1 = (await loadCoach('TEST', NOW, d))!.subjects[0].key;
    // 과목1 15문항 모두 모름
    await solveSet((await startSubject('TEST', k1, NOW, d))!, () => 0);
    const c = (await loadCoach('TEST', NOW, d))!;
    const s1 = c.subjects.find((s) => s.key === k1)!;
    expect(s1.current).toBeLessThan(5); // 거의 0점
    expect(s1.avail.relearn).toBe(15); // 오늘 모름 15 → 다시
    expect(s1.newRate.raw).toBeLessThan(0.05);
    expect(s1.newRate.exam).toBeGreaterThan(0.2); // 시험에선 찍어서 25%
    // 기출(같은 문항 + 변형) 비율: 2회차뿐이라 실측 곡선(1~2회차 보유 시 2~3%) 쪽으로 — 실측 1문항 반복은 거의 반영 안 됨(ADR 013)
    expect(c.exam.rho).toBeGreaterThan(0.01);
    expect(c.exam.rho).toBeLessThan(0.12);
    expect(c.exam.shares.same + c.exam.shares.variant + c.exam.shares.fresh).toBeCloseTo(1);
    expect(s1.examProjected!).toBeLessThan(40); // 모름만 누른 과목: 기출 2회차 분량으로는 과락
    expect(c.exam.status === 'unknown' || c.exam.status === 'fail-subject').toBe(true);
    // 오늘 학습 순서: 진단이 덜 된 과목2 먼저
    expect(c.order[0]).not.toBe(k1);
  });
});

describe('실기기 v0.5.0 보완(ADR 011)', () => {
  it('학습시간을 늘리면(새로 익힐 기출이 남아 있으면) 시험일 예상 점수가 오른다', async () => {
    await twoRounds();
    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 5 }, d);
    const k1 = (await loadCoach('TEST', NOW, d))!.subjects[0].key;
    await solveSet((await startSubject('TEST', k1, NOW, d))!, (i) => (i % 2 ? 1 : 0)); // 첫 풀이 기록이 있어야 진단
    const low = (await loadCoach('TEST', NOW, d))!.exam.projectedAvg!;
    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 180 }, d);
    const high = (await loadCoach('TEST', NOW, d))!.exam.projectedAvg!;
    expect(high).toBeGreaterThan(low);
  });

  it('모의고사 풀이는 현재 점수·오늘 학습량·추천에 넣지 않는다(이력은 모의고사에만)', async () => {
    await twoRounds();
    const before = (await loadCoach('TEST', NOW, d))!;
    await solveSet((await startMock('TEST', NOW, d))!, () => 1); // 전부 정답
    const after = (await loadCoach('TEST', NOW + 60_000, d))!;
    expect(after.exam.current).toBe(before.exam.current);
    expect(after.doneToday).toBe(0);
    expect((await mockHistory('TEST', d))[0].result.avgScore).toBe(100);
  });

  it('추천 묶음: 복습은 최대 60%, 나머지는 새 문항', async () => {
    await twoRounds();
    const k1 = (await loadCoach('TEST', NOW, d))!.subjects[0].key;
    await solveSet((await startSubject('TEST', k1, NOW, d))!, () => 2); // 15문항 모두 틀림
    const c = (await loadCoach('TEST', NOW + 60_000, d))!;
    expect(c.today.relearn).toBeLessThanOrEqual(Math.ceil(c.today.size * 0.6));
    expect(c.today.fresh).toBeGreaterThan(0);
  });
});

describe('v0.11 현재 점수 = 푼 문항 중 정답 비율(ADR 020)', () => {
  it('안 푼 문항은 분모에서 빠지고, 같은 문항을 여러 번 풀면 1문항·최근 답으로', async () => {
    await twoRounds();
    let c = (await loadCoach('TEST', NOW, d))!;
    expect(c.exam.current).toBeNull(); // 아직 푼 문항 없음 → —
    expect(c.subjects.every((s) => s.current == null && s.solved === 0)).toBe(true);
    const q1 = (await d.questions.get('TEST-2022-1-001'))!; // 과목1
    const q2 = (await d.questions.get('TEST-2022-1-002'))!; // 과목1
    const q3 = (await d.questions.get('TEST-2022-1-011'))!; // 과목2
    const run = (await startSubject('TEST', c.subjects[0].key, NOW, d))!;
    let s = (await loadSession(run, d))!;
    const ans = async (q: typeof q1, chosen: number, ts: number) => {
      s = (await recordAnswer(s, q, chosen, 30_000, { now: ts }, d)).session;
    };
    // 직접 원장에 답을 쌓는다(묶음에 없는 문항도 원장은 문항 단위)
    await ans(q1, 2, NOW + 1); // 오답
    await ans(q2, 1, NOW + 2); // 정답
    await ans(q3, 0, NOW + 3); // 모름 = 오답
    c = (await loadCoach('TEST', NOW + 10, d))!;
    expect([c.exam.solved, c.exam.correct, c.exam.current]).toEqual([3, 1, 33.3]);
    const s1 = c.subjects.find((x) => x.name === '과목1')!;
    const s2 = c.subjects.find((x) => x.name === '과목2')!;
    expect([s1.solved, s1.correct, s1.current]).toEqual([2, 1, 50]);
    expect([s2.solved, s2.correct, s2.current]).toEqual([1, 0, 0]);
    // q1을 다시 풀어 맞힘 → 푼 문항 수는 그대로 3, 정답만 최신으로(회독 미반영)
    const again = (await startRelearn('TEST', [q1.qid], NOW + 20, d))!;
    s = (await loadSession(again, d))!;
    await ans(q1, 1, NOW + 21);
    c = (await loadCoach('TEST', NOW + 30, d))!;
    expect([c.exam.solved, c.exam.correct, c.exam.current]).toEqual([3, 2, 66.7]);
    expect(c.subjects.find((x) => x.name === '과목1')!.current).toBe(100);
    // 최근 답이 오답이면 다시 오답으로
    const again2 = (await startRelearn('TEST', [q1.qid], NOW + 40, d))!;
    s = (await loadSession(again2, d))!;
    await ans(q1, 3, NOW + 41);
    c = (await loadCoach('TEST', NOW + 50, d))!;
    expect([c.exam.solved, c.exam.correct]).toEqual([3, 1]);
  });

  it('하루가 지나면 어제 묶음은 이어지지 않는다 — 새로 시작하면 오늘 남은 목표만큼', async () => {
    await twoRounds();
    await savePlanSettings('TEST', { examDate: '2027-01-18', dailyMinutes: 22.5 }, d); // 하루 15문항
    const y = (await startToday('TEST', NOW, d))!;
    await solveSet(y, () => 1, 4); // 어제 4문항만 풀고 그만
    const tomorrow = NOW + 24 * 3_600_000;
    const c = (await loadCoach('TEST', tomorrow, d))!;
    expect(c.doneToday).toBe(0);
    expect(c.today.size).toBe(15); // 어제 남은 11이 아니라 오늘 목표 15
    const t = (await startToday('TEST', tomorrow, d))!;
    expect((await loadSession(t, d))!.qids).toHaveLength(15);
    expect((await d.runs.get((y as { sessionId: string }).sessionId))!.finishedAt).toBe(tomorrow);
  });
});
