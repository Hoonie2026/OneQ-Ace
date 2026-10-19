import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OneQDB } from './db';
import { importPackBytes } from './pack/import';
import { makePack } from './test/makePack';
import { deletePacks, wipeCertRecords } from './wipe';
import { loadEngine, savePlanSettings, loadPlanSettings, passOutlook } from './engine';
import { buildBank } from './engine/items';
import { replay } from './engine/memory';
import { itemExamP, examTime } from './engine/predict';
import { buildConcepts, curveShares } from './engine/similar';
import { googleUrl, searchQuery } from './search';
import { DEFAULT_PLAN_SETTINGS, type EngineQuestion } from './engine/types';
import { loadSession, recordAnswer, createSetRun } from './study';

let d: OneQDB;
let n = 0;
beforeEach(() => {
  d = new OneQDB(`v07-${++n}`);
});
afterEach(async () => {
  await d.delete();
});

const NOW = new Date(2027, 0, 4, 9).getTime();

describe('삭제 통로 일원화(v0.7)', () => {
  async function seed() {
    for (const code of ['AAA', 'BBB'])
      for (const round of [1, 2]) {
        const questions = Array.from({ length: 4 }, (_, i) => ({ hash: `${code}${round}${i}`, answer: 1 }));
        await importPackBytes(await makePack({ code, round, questions }), {}, d);
      }
    // 각 종목 2회차 문항 하나씩 풀이
    for (const code of ['AAA', 'BBB']) {
      const qids = [`${code}-2022-1-001`, `${code}-2022-2-001`];
      const run = await createSetRun(code, 'today', 't', qids, { now: NOW }, d);
      let s = (await loadSession({ kind: 'set', sessionId: run.sessionId }, d))!;
      for (const qid of qids) ({ session: s } = await recordAnswer(s, (await d.questions.get(qid))!, 1, 30_000, { now: NOW }, d));
      await savePlanSettings(code, { examDate: '2027-02-01' }, d);
    }
  }

  it('종목 하나의 학습 기록만 지우기: 다른 종목·문제팩·학습 계획은 그대로', async () => {
    await seed();
    const r = await wipeCertRecords('AAA', d);
    expect(r.attempts).toBe(2);
    expect(await d.attempts.count()).toBe(2); // BBB 2건
    expect(await d.packs.count()).toBe(4);
    expect(await loadPlanSettings('AAA', d)).not.toBeNull();
  });

  it('문제팩 일부 삭제: 그 팩 문항의 기록도 함께, 전체를 고르면 종목 삭제(학습 계획까지)', async () => {
    await seed();
    let r = await deletePacks(['AAA-2022-1'], d);
    expect([r.packs, r.attempts, r.certsGone]).toEqual([1, 1, []]);
    expect(await d.orphans.count()).toBe(0); // 예전 개별 삭제처럼 '매핑 대기'로 보관하지 않는다
    expect((await d.attempts.toArray()).map((a) => a.qid).sort()).toEqual(['AAA-2022-2-001', 'BBB-2022-1-001', 'BBB-2022-2-001']);
    r = await deletePacks(['AAA-2022-2'], d);
    expect(r.certsGone).toEqual(['AAA']);
    expect(await loadPlanSettings('AAA', d)).toBeNull();
    expect(await loadPlanSettings('BBB', d)).not.toBeNull();
    expect(await d.packs.count()).toBe(2);
  });
});

describe('예상 점수 재검토(ADR 013)', () => {
  const Q = (qid: string, examDate: string, text: string, subjectName = '과목A'): EngineQuestion => ({ qid, packId: qid.slice(0, -4), examDate, subjectName, text, clusterId: null });

  it('표현·보기만 바꾼 변형 문항은 같은 개념 군집으로, 원 문항을 익히면 변형도 더 맞힌다', () => {
    const qs = [
      // 측량 2013-1 97번 ↔ 2016-1 98번(유사도 0.72): 같은 개념, 표현·보기 하나만 다름
      Q('T-2020-1-001', '2020-03-01', '1. 주기적인 측량기본계획에 포함되어야 할 사항과 거리가 먼 것은? ① 측량에 관한 기본 구상 및 추진 전략 ② 측량산업 및 기술인력 육성 방안 ③ 측량의 국내외 환경 분석 및 기술연구 ④ 세계측량기구의 가입 및 협력 방안'),
      Q('T-2021-1-001', '2021-03-01', '1. 5년마다 수립하게 되어 있는 측량기본계획에 포함되어야 하는 사항이 아닌 것은? ① 측량에 관한 기본 구상 및 추진 전략 ② 측량의 국내외 환경 분석 및 기술연구 ③ 측량산업 및 기술인력 육성 방안 ④ 협회의 운영 및 관리'),
      Q('T-2021-1-002', '2021-03-01', '2. 하천의 수위 중 저수위에 대한 설명으로 옳은 것은? ① 1년을 통하여 355일 이것보다 내려가지 않는 수위 ② 275일 ③ 185일 ④ 125일'),
      // 서로 다른 주제의 문항들(글자 빈도의 기준이 되도록)
      ...['GNSS 측량의 특징에 대한 설명으로 옳지 않은 것은? ① 실내외 측량 ② 날씨와 무관 ③ 24시간 ④ 전 지구적',
        '클로소이드 곡선에 대한 설명으로 틀린 것은? ① 완화곡선의 일종 ② 매개변수 ③ 곡률 ④ 접선각',
        '공공측량 작업계획서에 포함되지 않아도 되는 사항은? ① 시행자의 규모 ② 위치 및 사업량 ③ 목적 ④ 측량기기',
        '항공사진의 초점거리와 촬영고도로 축척을 구하면? ① 1/10000 ② 1/15000 ③ 1/20000 ④ 1/25000',
        '지리정보시스템에서 래스터 자료구조의 장점은? ① 중첩분석 용이 ② 자료구조 단순 ③ 원격탐사 자료 ④ 위상관계',
        '수준측량에서 전시와 후시의 거리를 같게 하는 이유는? ① 시준축 오차 ② 지구곡률 ③ 대기굴절 ④ 표척 눈금',
        '삼각측량의 각 관측에서 생기는 오차의 조정 방법은? ① 각조건 ② 변조건 ③ 측점조건 ④ 방향각',
        '등고선의 성질에 대한 설명으로 옳지 않은 것은? ① 경사가 급하면 간격이 좁다 ② 교차하지 않는다 ③ 폐합한다 ④ 분기한다'].map((t, i) => Q(`T-2019-1-0${10 + i}`, '2019-03-01', `${i + 10}. ${t}`)),
    ];
    const bank = buildBank(qs);
    const { concepts } = buildConcepts(bank, (q) => qs.find((x) => x.qid === q)!.text);
    const [a, b, c] = ['T-2020-1-001', 'T-2021-1-001', 'T-2021-1-002'].map((q) => bank.itemOf.get(q)!);
    expect(concepts.clusterOf.get(a.key)).toBe(concepts.clusterOf.get(b.key));
    expect(concepts.clusterOf.get(c.key)).not.toBe(concepts.clusterOf.get(a.key));
    const mem = replay(bank, [{ qid: 'T-2020-1-001', ts: NOW, correct: true, chosen: 1, unsure: false, elapsedMs: 60_000 }]);
    const T = examTime('2027-01-10');
    const prior = mem.prior.get(a.subjectKey)!;
    expect(itemExamP(b, mem, T, false, concepts)).toBeGreaterThan(prior + 0.2);
    expect(itemExamP(b, mem, T, false)).toBeCloseTo(prior); // 군집 없이는 그대로
    expect(itemExamP(c, mem, T, false, concepts)).toBeCloseTo(prior);
  });

  it('보유 회차가 많을수록 기출(같은·변형) 비율이 오른다(측량 실측 곡선)', () => {
    const few = curveShares(2);
    const many = curveShares(30);
    expect(few.same + few.variant).toBeLessThan(0.05);
    expect(many.same + many.variant).toBeGreaterThan(0.6);
  });

  it('시험 직전 날짜별 학습시간을 늘리면 시험일 투영 점수가 오른다(마지막 복습)', async () => {
    for (const round of [1, 2, 3]) {
      const questions = Array.from({ length: 40 }, (_, i) => ({ hash: `r${round}q${i}`, answer: 1, subjectNo: i < 20 ? 1 : 2 }));
      await importPackBytes(await makePack({ year: 2020 + round, round, questions }), {}, d);
    }
    const ctx = (await loadEngine('TEST', d))!;
    // 문항 절반을 미리 익힌 상태
    const attempts = ctx.bank.items
      .filter((_, i) => i % 2 === 0)
      .map((it, i) => ({ qid: it.qids[0], ts: NOW - 86_400_000 * 10 + i, correct: i % 2 === 0, chosen: i % 2 === 0 ? 1 : 2, unsure: false, elapsedMs: 60_000 }));
    const mem = replay(ctx.bank, attempts);
    const base = { ...DEFAULT_PLAN_SETTINGS, examDate: '2027-01-20', dailyMinutes: 3 };
    const plain = passOutlook(ctx.bank, mem, base, NOW);
    const cram = passOutlook(ctx.bank, mem, { ...base, dayMinutes: { '2027-01-18': 300, '2027-01-19': 300 } }, NOW);
    expect(cram.plannedMinutes).toBeGreaterThan(plain.plannedMinutes);
    expect(cram.projectedAverage).toBeGreaterThan(plain.projectedAverage + 1);
  });

  it('답하기 전에 웹검색하고 맞힌 풀이는 "자신 없이 맞힘" — 첫 풀이 정답률에선 찍은 것(25%)으로', async () => {
    await importPackBytes(await makePack({ questions: Array.from({ length: 4 }, (_, i) => ({ hash: `s${i}`, answer: 1 })) }), {}, d);
    const qids = ['TEST-2022-1-001', 'TEST-2022-1-002'];
    const run = await createSetRun('TEST', 'today', 't', qids, { now: NOW }, d);
    let s = (await loadSession({ kind: 'set', sessionId: run.sessionId }, d))!;
    let a;
    ({ session: s, attempt: a } = await recordAnswer(s, (await d.questions.get(qids[0]))!, 1, 30_000, { now: NOW, unsure: true }, d));
    expect(a.unsure).toBe(true);
    ({ session: s, attempt: a } = await recordAnswer(s, (await d.questions.get(qids[1]))!, 2, 30_000, { now: NOW, unsure: true }, d));
    expect(a.unsure).toBe(false); // 틀린 답은 그냥 오답
  });
});

describe('웹검색 검색어(v0.7)', () => {
  it('지문의 핵심 낱말만: 문제 꼬리·숫자·보기 제외, 과목명 덧붙임', () => {
    const q = searchQuery('19. GNSS측량방법 중 가장 정밀한 위치결정방법으로 기준점측량이나 학술목적으로 주로 사용되는 방법은? ① 정지(Static) 측량 ② 이동 측량', '측지학 및 위성측위시스템');
    expect(q).toContain('GNSS측량방법');
    expect(q).not.toContain('정지');
    expect(q).toContain('측지학 및 위성측위시스템');
    const r = searchQuery('28. 반지름 267.90m, 교각 87° 15′ 56″ 인 단곡선의 중앙종거는? ① 72.00m ② 73.00m', '응용측량');
    expect(r).toBe('반지름 교각 단곡선의 중앙종거 응용측량');
    const t = searchQuery('1. 탄성파 측정에 대한 설명 중 틀린 것은? ① 굴절법은 지표면으로부터 낮은 곳을 대상으로 한다.');
    expect(t).toBe('탄성파 측정에 대한 설명');
    expect(googleUrl('a b')).toBe('https://www.google.com/search?q=a%20b');
  });
});

describe('v0.7.1', () => {
  it('오늘 학습 마치기: 열린 오늘 학습 묶음을 닫고(기록은 그대로) 오늘 결과를 센다', async () => {
    const { finishToday, todayStatus } = await import('./coach');
    await importPackBytes(await makePack({ questions: Array.from({ length: 6 }, (_, i) => ({ hash: `f${i}`, answer: 1 })) }), {}, d);
    await savePlanSettings('TEST', { examDate: '2027-02-01', dailyMinutes: 6 }, d); // 6분 ÷ 1.5분 = 4문항
    const qids = ['TEST-2022-1-001', 'TEST-2022-1-002', 'TEST-2022-1-003'];
    const run = await createSetRun('TEST', 'today', '오늘 학습', qids, { now: NOW }, d);
    let s = (await loadSession({ kind: 'set', sessionId: run.sessionId }, d))!;
    ({ session: s } = await recordAnswer(s, (await d.questions.get(qids[0]))!, 1, 30_000, { now: NOW }, d));
    ({ session: s } = await recordAnswer(s, (await d.questions.get(qids[1]))!, 0, 30_000, { now: NOW + 1 }, d));
    const st = (await todayStatus('TEST', NOW + 2, d))!;
    expect(st).toEqual({ target: 4, done: 2, correct: 1, wrong: 0, unknown: 1 });
    expect(await finishToday('TEST', NOW + 3, d)).toBe(1);
    expect((await d.runs.get(run.sessionId))!.finishedAt).toBe(NOW + 3);
    expect(await d.attempts.count()).toBe(2);
    expect(await finishToday('TEST', NOW + 4, d)).toBe(0);
  });

  it('웹검색은 구글 AI 모드(udm=50)로, 개념 설명을 묻는 문장', async () => {
    const { aiModeUrl } = await import('./search');
    const u = new URL(aiModeUrl('단곡선의 중앙종거', '측량및지형공간정보기사'));
    expect(u.searchParams.get('udm')).toBe('50');
    expect(u.searchParams.get('q')).toBe('단곡선의 중앙종거 — 측량및지형공간정보기사 필기 시험 대비로 이 개념을 쉽게 설명해 줘');
  });
});

describe('v0.7.2', () => {
  it('과목 학습 한 묶음 = 오늘 남은 목표 문항 수(시스템 추천과 같음), 다 채웠으면 추가 15', async () => {
    const { startSubject, loadCoach } = await import('./coach');
    await importPackBytes(await makePack({ questions: Array.from({ length: 30 }, (_, i) => ({ hash: `z${i}`, answer: 1 })) }), {}, d);
    await savePlanSettings('TEST', { examDate: '2027-02-01', dailyMinutes: 12 }, d); // 8문항
    const k = (await loadCoach('TEST', NOW, d))!.subjects[0].key;
    const t = (await startSubject('TEST', k, NOW, d))!;
    let s = (await loadSession(t, d))!;
    expect(s.qids).toHaveLength(8);
    for (const qid of s.qids) ({ session: s } = await recordAnswer(s, (await d.questions.get(qid))!, 1, 30_000, { now: NOW }, d));
    const t2 = (await startSubject('TEST', k, NOW + 1000, d))!;
    expect((await loadSession(t2, d))!.qids).toHaveLength(15);
  });
});
