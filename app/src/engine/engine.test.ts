import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rating } from 'ts-fsrs';
import { OneQDB } from '../db';
import { importPackBytes } from '../pack/import';
import { makePack } from '../test/makePack';
import { addDays, parseDate } from './days';
import { buildBank, byFrequency, sameKey, subjectKey } from './items';
import { gradeOf, replay } from './memory';
import { forecast } from './predict';
import { planWeek, weekStartOf } from './plan';
import { buildTodaySession, interleave, retryTail } from './session';
import { buildMock } from './mock';
import { engineMock, enginePlan, engineToday, loadEngine, savePlanSettings } from './load';
import { syntheticBank } from './sim';
import { DEFAULT_PLAN_SETTINGS, type EngineAttempt, type EngineQuestion } from './types';

const q = (qid: string, subjectName: string, text: string, examDate = '2022-03-05'): EngineQuestion => ({
  qid,
  packId: qid.slice(0, -4),
  examDate,
  subjectName,
  text,
  clusterId: null,
});
const T0 = new Date(2027, 0, 4, 9).getTime(); // 월요일 9시
const att = (qid: string, dayOffset: number, correct: boolean, extra: Partial<EngineAttempt> = {}): EngineAttempt => ({
  qid,
  ts: T0 + dayOffset * 86_400_000,
  correct,
  chosen: correct ? 1 : 2,
  unsure: false,
  elapsedMs: 60_000,
  ...extra,
});

describe('과목·동일 문항', () => {
  it('과목명 정규화: 공백·가운뎃점·괄호 차이를 무시', () => {
    expect(subjectKey('사진측량 및 원격탐사')).toBe(subjectKey('사진측량및 원격탐사'));
    expect(subjectKey('측량학(측량관계법규)')).toBe(subjectKey('측량학 측량관계법규'));
    expect(subjectKey('철도·궤도')).toBe(subjectKey('철도 궤도'));
    expect(subjectKey('응용측량')).not.toBe(subjectKey('측량학'));
  });

  it('동일 문항 키: 문항 번호·띄어쓰기·보기 순서가 달라도 같다', () => {
    const a = '39. 노선측량의 작업순서로 옳은 것은?\n① 가 - 나 ② 다-라\n③ 마 ④ 바';
    const b = '21. 노선측량의  작업 순서로 옳은 것은?\n① 다 - 라 ② 가-나\n③ 바 ④ 마';
    expect(sameKey(a)).toBe(sameKey(b));
    expect(sameKey(a)).not.toBe(sameKey('21. 노선측량의 작업순서로 틀린 것은?\n① 가 - 나 ② 다-라\n③ 마 ④ 바'));
  });

  it('학습 단위 = 과목별 동일 문항 묶음, 현행 과목 = 가장 최근 회차', () => {
    const bank = buildBank([
      q('A-2021-1-001', '측량학', '1. 같은 문제 ① 가 ② 나 ③ 다 ④ 라', '2021-03-07'),
      q('A-2021-1-002', '건설재료', '2. 옛 과목 문제 ① 가 ② 나 ③ 다 ④ 라', '2021-03-07'),
      q('A-2022-1-001', '측량 학', '7. 같은 문제 ① 나 ② 가 ③ 다 ④ 라', '2022-03-05'),
      q('A-2022-1-002', '측량학', '8. 다른 문제 ① 가 ② 나 ③ 다 ④ 라', '2022-03-05'),
    ]);
    expect(bank.subjects.filter((s) => s.current).map((s) => s.name)).toEqual(['측량학']);
    expect(bank.subjects.find((s) => s.name === '건설재료')!.current).toBe(false);
    expect(bank.items).toHaveLength(2); // 폐지 과목은 학습 단위에서 빠진다
    const top = byFrequency(bank.items)[0];
    expect(top.qids).toEqual(['A-2022-1-001', 'A-2021-1-001']); // 최근 회차가 대표
    expect(bank.questionCount.get(subjectKey('측량학'))).toBe(3);
  });
});

describe('FSRS 등급(6.2)과 원장 재생', () => {
  it('오답·모름 Again, 헷갈림·오래 걸림 Hard, 정답 Good', () => {
    expect(gradeOf(att('x', 0, false), 60_000)).toBe(Rating.Again);
    expect(gradeOf(att('x', 0, false, { chosen: 0 }), 60_000)).toBe(Rating.Again);
    expect(gradeOf(att('x', 0, true, { unsure: true }), 60_000)).toBe(Rating.Hard);
    expect(gradeOf(att('x', 0, true, { elapsedMs: 90_000 }), 60_000)).toBe(Rating.Hard);
    expect(gradeOf(att('x', 0, true, { elapsedMs: 89_000 }), 60_000)).toBe(Rating.Good);
  });

  it('같은 날 다시 푼 것은 카드에 반영하지 않고, 다른 회차의 같은 문항은 기억을 공유한다', () => {
    const bank = buildBank([
      q('A-2021-1-001', '측량학', '1. 같은 문제 ① 가 ② 나 ③ 다 ④ 라', '2021-03-07'),
      q('A-2022-1-005', '측량학', '5. 같은 문제 ① 가 ② 나 ③ 다 ④ 라'),
    ]);
    const one = replay(bank, [att('A-2021-1-001', 0, false)]);
    const twoSameDay = replay(bank, [att('A-2021-1-001', 0, false), att('A-2021-1-001', 0, true)]);
    const k = bank.items[0].key;
    expect(twoSameDay.items.get(k)!.card).toEqual(one.items.get(k)!.card);
    expect(twoSameDay.items.get(k)!.attempts).toBe(2);
    const nextDayOther = replay(bank, [att('A-2021-1-001', 0, true), att('A-2022-1-005', 3, true)]);
    expect(nextDayOther.items.get(k)!.card.reps).toBe(2);
  });
});

describe('예상 점수(6.3)·주간 계획(6.4)·세션(6.5)', () => {
  const qs = syntheticBank(10);
  const bank = buildBank(qs);
  const settings = { ...DEFAULT_PLAN_SETTINGS, examDate: '2027-03-01' };

  it('기록이 없으면 모든 과목 25점(추측 확률) → 과락 위험', () => {
    const fc = forecast(bank, replay(bank, []), settings.examDate, settings.passRule);
    expect(fc.subjects).toHaveLength(5);
    for (const s of fc.subjects) {
      expect(s.score).toBe(25);
      expect(s.risk).toBe('fail-subject');
    }
    expect(fc.overall).toBe('fail-subject');
  });

  it('주간 계획: 가용량을 넘지 않고, 첫 주는 과목 진단으로 모든 과목을 고루 낸다', () => {
    const plan = planWeek({ bank, mem: replay(bank, []), attempts: [], settings, now: T0 });
    expect(plan.weekStart).toBe('2027-01-04');
    expect(plan.items.length).toBeLessThanOrEqual(plan.capacity);
    expect(plan.capacity).toBe(Math.floor(((60 * 60) / 90) * 6)); // 하루 60분 ÷ 1.5분 × 남은 학습일 6
    const first = plan.items.slice(0, 10).map((p) => p.item.subjectKey);
    expect(new Set(first).size).toBe(5);
    expect(plan.shortage).not.toBeNull(); // 1,000문항을 하루 60분으로는 다 못 본다
    expect(plan.shortage!.extraMinutesPerDay).toBeGreaterThan(0);
  });

  it('여유가 있으면 부족 경고가 없다', () => {
    const plan = planWeek({ bank, mem: replay(bank, []), attempts: [], settings: { ...settings, dailyMinutes: 600 }, now: T0 });
    expect(plan.shortage).toBeNull();
  });

  it('틀린 문항은 다음 날 약점 복습으로 나온다', () => {
    const qid = bank.items[0].qids[0];
    const attempts = [att(qid, 0, false)];
    const plan = planWeek({ bank, mem: replay(bank, attempts), attempts, settings, now: T0 + 86_400_000 });
    const p = plan.items.find((x) => x.item.qids.includes(qid))!;
    expect(p.slot).toBe('weak');
  });

  it('오늘 이미 푼 문항은 오늘 목표에서 빠진다', () => {
    const qid = bank.items[0].qids[0];
    const attempts = [att(qid, 0, false)];
    const plan = planWeek({ bank, mem: replay(bank, attempts), attempts, settings, now: T0 + 3_600_000 });
    expect(plan.items.some((x) => x.item.qids.includes(qid))).toBe(false);
    expect(plan.doneThisWeek).toBe(1);
  });

  it('마지막 주: 과락 위험이 아닌 과목은 신규 없이 복습만', () => {
    const mem = replay(bank, []);
    const plan = planWeek({ bank, mem, attempts: [], settings: { ...settings, examDate: '2027-01-08' }, now: T0 });
    expect(plan.finalWeek).toBe(true);
    // 기록이 없으면 전 과목이 과락 위험이라 신규가 허용된다
    expect(plan.counts.new).toBeGreaterThan(0);
  });

  it('세션: 15문항, 같은 과목 연속 3문항 이내', () => {
    const plan = planWeek({ bank, mem: replay(bank, []), attempts: [], settings, now: T0 });
    const s = buildTodaySession(plan, parseDate('2027-01-04'));
    expect(s).toHaveLength(15);
    let run = 1;
    for (let i = 1; i < s.length; i++) {
      run = s[i].subjectKey === s[i - 1].subjectKey ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(3);
    }
  });

  it('교차 배열과 세션 끝 재출제', () => {
    const xs = 'AAAAAAB'.split('').map((subjectKey, i) => ({ subjectKey, qid: String(i), itemKey: String(i), slot: 'new' as const }));
    const out = interleave(xs);
    expect(out.map((x) => x.subjectKey).join('')).toBe('AAABAAA'); // 다른 과목이 없으면 이어 붙인다
    expect(retryTail(out, new Set(['0', '6'])).map((x) => x.qid)).toEqual(['0', '6']);
  });

  it('주 시작은 월요일', () => {
    expect(weekStartOf(addDays(T0, 6))).toBe(parseDate('2027-01-04'));
    expect(weekStartOf(addDays(T0, 7))).toBe(parseDate('2027-01-11'));
  });
});

describe('모의고사 출제 방식', () => {
  const bank = buildBank(syntheticBank(30));

  it('현행 과목마다 실제 문항 수만큼, 같은 내용은 한 번만, 시드가 같으면 같은 시험지', () => {
    const mem = replay(bank, []);
    const a = buildMock(bank, mem, { seed: 7 });
    expect(a.bySubject.map((s) => s.qids.length)).toEqual([20, 20, 20, 20, 20]);
    expect(new Set(a.qids.map((x) => bank.itemOf.get(x)!.key)).size).toBe(100);
    expect(a.minutes).toBe(150);
    expect(buildMock(bank, mem, { seed: 7 }).qids).toEqual(a.qids);
    expect(buildMock(bank, mem, { seed: 8 }).qids).not.toEqual(a.qids);
  });

  it('시뮬레이션: 빈도 가중 무작위만 모의고사 점수 기댓값이 예상 점수와 맞는다(약점 가중은 낮게 치우침)', () => {
    // 일부 문항을 학습한 상태를 만든다: 앞쪽 회차를 많이 풀어 둔다
    const attempts: EngineAttempt[] = [];
    bank.items.slice(0, 1200).forEach((it, i) => attempts.push(att(it.qids[0], -(i % 20), i % 3 !== 0)));
    const mem = replay(bank, attempts);
    const now = T0;
    const fc = forecast(bank, mem, '2027-01-04', DEFAULT_PLAN_SETTINGS.passRule);
    const expected = (strategy: 'frequency' | 'random' | 'weak') => {
      let sum = 0;
      const n = 200;
      for (let seed = 1; seed <= n; seed++) {
        const m = buildMock(bank, mem, { seed, strategy, now });
        const T = now;
        let s = 0;
        for (const qid of m.qids) {
          const it = bank.itemOf.get(qid)!;
          const mm = mem.items.get(it.key);
          const prior = mem.prior.get(it.subjectKey)!;
          // 시험 당일(now) 정답 확률
          const r = mm ? Math.pow(1 + (Math.pow(0.9, -1 / mem.curve.decay) - 1) * Math.max(0, (T - mm.card.last_review!.getTime()) / 86_400_000) / (mm.card.stability * mem.curve.scale), -mem.curve.decay) : 0;
          s += r + (1 - r) * prior;
        }
        sum += (100 * s) / m.qids.length;
      }
      return sum / n;
    };
    const freq = expected('frequency');
    const weak = expected('weak');
    expect(Math.abs(freq - fc.average)).toBeLessThan(1.5);
    expect(weak).toBeLessThan(fc.average - 3);
  });
});

describe('DB 연결(load.ts)', () => {
  let d: OneQDB;
  let n = 0;
  beforeEach(() => {
    d = new OneQDB(`e${++n}`);
  });
  afterEach(async () => {
    await d.delete();
  });

  it('팩·풀이 기록에서 계획·오늘 세션·모의고사를 만든다. 시험일이 없으면 계획 없음', async () => {
    const mk = (round: number) =>
      makePack({ round, questions: Array.from({ length: 6 }, (_, i) => ({ hash: `r${round}q${i}`, answer: 1, subjectNo: i < 3 ? 1 : 2 })) });
    await importPackBytes(await mk(1), {}, d);
    await importPackBytes(await mk(2), {}, d);
    let ctx = (await loadEngine('TEST', d))!;
    expect(ctx.bank.items).toHaveLength(12);
    expect(ctx.settings).toBeNull();
    expect(enginePlan(ctx, T0)).toBeNull();
    expect(engineToday(ctx, T0)).toEqual([]);

    await savePlanSettings('TEST', { examDate: '2027-02-01' }, d);
    await d.attempts.add({ uid: 'u1', qid: 'TEST-2022-1-001', contentHash: 'x', ts: T0 - 86_400_000, chosen: 2, correct: false, unsure: false, elapsedMs: 5000, mode: 'round', sessionId: 's' });
    ctx = (await loadEngine('TEST', d))!;
    expect(ctx.settings!.examDate).toBe('2027-02-01');
    expect(ctx.settings!.passRule).toEqual({ subjectMin: 40, avgMin: 60 });
    const plan = enginePlan(ctx, T0)!;
    expect(plan.items.find((p) => p.item.qids.includes('TEST-2022-1-001'))!.slot).toBe('weak');
    expect(engineToday(ctx, T0).length).toBe(12); // 15보다 적으면 있는 만큼
    expect(engineMock(ctx, 1).qids.length).toBeGreaterThan(0);
  });
});
