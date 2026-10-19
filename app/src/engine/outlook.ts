/**
 * 합격 기준 경고(ADR 007). "지금 계획한 시간으로 시험일에 과목별 40점·평균 60점을 넘길 수 있는가,
 * 아니라면 하루 몇 분이면 되는가"를 계산한다. 5단계 홈의 경고 카드가 이 결과를 쓴다.
 *
 * 투영 모형(가벼운 어림 — 계획 엔진의 Δ 선택과 같은 방향):
 * - 학습 단위 하나를 "익히면" 시험일 정답 확률 = R* + (1 − R*)·prior. R*는 시험 전까지 간격 복습을 마쳤을 때의 기억률
 * - 비용(문항 풀이 횟수): 미학습은 첫 풀이 + 틀리면 다시 + 복습 2회, 학습한 것은 복습 1회(+ 틀리면 다시)
 * - 남은 풀이 횟수(가용량)를 ① 과락선 아래 과목부터 그 과목 목표까지 ② 남으면 평균 목표까지, 효율(점/회) 순으로 쓴다
 * - 필요 시간 = 목표에 드는 풀이 횟수 × 문항당 시간 ÷ 남은 날 — 권장(여유 포함)과 최소(과락선·합격선 그대로) 두 가지.
 *   예: 시험 2일 전에도 불확실하면 "남은 2일 동안 매일 최소 ○시간"(ADR 007 — 특정 날을 연차로 정하지 않고 필요한 시간을 알린다)
 *
 * 투영은 "계획대로 하면 도달할 수 있는 점수"라 예상 점수(predict.ts, 지금 멈추면 받을 점수)보다 높다.
 */
import { addDays, daysBetween, parseDate, startOfDay } from './days';
import type { Bank } from './items';
import { recallAt, type MemoryState } from './memory';
import { studyTime } from './minutes';
import type { Item } from './items';
import { examTime, forecast, itemExamP } from './predict';
import type { PlanSettings } from './types';

/** 간격 복습을 마친 학습 단위의 시험일 기억률(시뮬레이션으로 정함 — ADR 007) */
export const LEARNED_R = 0.85;
/** 미학습 단위를 익히는 데 드는 풀이 횟수: 기본 + 틀릴 확률 × 추가 */
export const NEW_COST_BASE = 2.5;
export const NEW_COST_WRONG = 1.5;
/** 과목별 진단이 이만큼 안 됐으면 투영을 믿기 어렵다(진단 전) */
export const OUTLOOK_MIN_OBS = 10;

export type OutlookStatus = 'pass' | 'tight' | 'fail-subject' | 'avg-short' | 'unknown';

export interface SubjectOutlook {
  key: string;
  name: string;
  /** 지금 멈추면(예상 점수) */
  now: number;
  /** 계획한 시간대로 하면(투영) */
  projected: number;
  /** 과락선 + 여유/2까지 필요한 풀이 횟수(이미 넘으면 0) */
  needQuestions: number;
}

export interface PassOutlook {
  status: OutlookStatus;
  subjects: SubjectOutlook[];
  projectedAverage: number;
  /** 투영 점수가 과락선 아래인 과목 이름 */
  failSubjects: string[];
  /** 남은 학습일 수·계획한 학습시간 합(분) */
  studyDays: number;
  plannedMinutes: number;
  /** 시험까지 남은 날(오늘 포함, 시험일 제외). 아래 "하루 ○분"은 이 날들에 매일 공부한다고 보고 나눈 값 */
  daysLeft: number;
  /** 권장: 여유를 두고 합격(과목 ≥ 과락선 + 여유/2, 평균 ≥ 합격선 + 여유/2)하려면 매일 몇 분. 문항이 모자라 시간을 늘려도 안 되면 null */
  neededMinutesPerDay: number | null;
  /** 최소: 과락선·합격선에 딱 닿으려면 매일 최소 몇 분. 이보다 적으면 합격이 어렵다. 불가능하면 null */
  minMinutesPerDay: number | null;
  /** 지금 계획 대비 하루 몇 분 더 */
  extraMinutesPerDay: number;
  /** 보유 기출 전체를 시험일까지 익히는 데(남은 모든 학습 단위) 매일 필요한 시간(분) — 실제 시험 기준 안내에 쓴다(ADR 008) */
  coverMinutesPerDay: number | null;
  /** 과락만 벗어나는 데(모든 과목 ≥ 과락선 + 여유/2) 필요한 하루 평균 학습시간(분). 문항이 모자라면 null */
  fixMinutesPerDay: number | null;
  /** 과목 진단이 덜 돼(과목당 첫 풀이 OUTLOOK_MIN_OBS건 미만) 투영이 거친가 */
  rough: boolean;
}

interface Action {
  subjectKey: string;
  gain: number; // 과목 점수 상승(점)
  cost: number; // 풀이 횟수
  /** 이 행동을 하면 시험일 정답 확률이 target이 되는 학습 단위들(시험 직전 복습 대상) */
  items: { key: string; w: number }[];
}

/** 같은 개념의 변형 문항을 익히는 비용(풀이 횟수): 이미 아는 개념이라 처음 보는 문항(약 3.6회)보다 적다(ADR 013) */
export const VARIANT_COST = 1.7;
/** 시험 직전 며칠(달력)의 학습시간은 이미 익힌 문항의 마지막 복습에 먼저 쓴다(ADR 013) */
export const LATE_DAYS = 3;
/** 시험 직전에 다시 본 문항의 시험일 기억률 */
export const LATE_R = 0.95;

const r1 = (x: number) => Math.round(x * 10) / 10;

export function passOutlook(bank: Bank, mem: MemoryState, settings: PlanSettings, now: number): PassOutlook {
  const rule = settings.passRule;
  const m = settings.safetyMargin;
  const subjTarget = rule.subjectMin + m / 2;
  const avgTarget = rule.avgMin + m / 2;
  const today = startOfDay(now);
  const examDay = parseDate(settings.examDate);
  const T = examTime(settings.examDate);
  const daysLeft = Math.max(0, daysBetween(today, examDay));
  const time = daysLeft > 0 ? studyTime(settings, today, addDays(examDay, -1)) : { minutes: 0, days: 0 };
  const lateFrom = Math.max(today, addDays(examDay, -LATE_DAYS));
  const late = daysLeft > 0 ? studyTime(settings, lateFrom, addDays(examDay, -1)) : { minutes: 0, days: 0 };
  const sec = mem.secPerQuestion;
  const capacity = (time.minutes * 60) / sec;
  const lateCapacity = (late.minutes * 60) / sec;

  const fc = forecast(bank, mem, settings.examDate, rule, m);
  const current = new Set(fc.subjects.map((s) => s.key));
  const nS = bank.questionCount;
  const conc = bank.concepts;
  const priorOf = (sk: string) => mem.prior.get(sk) ?? 0.25;
  const targetOf = (sk: string) => LEARNED_R + (1 - LEARNED_R) * priorOf(sk);
  const wOf = (it: Item) => (it.qids.length * 100) / (nS.get(it.subjectKey) ?? 1);
  /** 지금 기록으로 본 시험일 정답 확률(투영의 출발점) */
  const p0 = new Map<string, number>();
  for (const it of bank.items) if (current.has(it.subjectKey)) p0.set(it.key, itemExamP(it, mem, T, false, conc));

  // 과목별 행동 목록(효율 높은 순). 개념 군집 단위: 아무것도 안 익힌 군집은 "대표 문항 + 변형들"을 한 행동으로
  const acts = new Map<string, Action[]>(fc.subjects.map((s) => [s.key, []]));
  const groups = conc ? [...conc.members.values()] : bank.items.map((it) => [it]);
  for (const g of groups) {
    const its = g.filter((it) => current.has(it.subjectKey));
    if (!its.length) continue;
    const sk = its[0].subjectKey;
    const prior = priorOf(sk);
    const target = targetOf(sk);
    const learned = its.filter((it) => mem.items.has(it.key));
    const fresh = its.filter((it) => !mem.items.has(it.key));
    for (const it of learned) {
      const p = p0.get(it.key)!;
      if (target > p) {
        const im = mem.items.get(it.key)!;
        const rNow = recallAt(im.card, now, mem.curve);
        acts.get(sk)!.push({ subjectKey: sk, gain: wOf(it) * (target - p), cost: 1 + (1 - (rNow + (1 - rNow) * prior)), items: [{ key: it.key, w: wOf(it) }] });
      }
    }
    if (!fresh.length) continue;
    if (learned.length) {
      for (const it of fresh) {
        acts.get(sk)!.push({ subjectKey: sk, gain: wOf(it) * Math.max(0, target - p0.get(it.key)!), cost: VARIANT_COST, items: [{ key: it.key, w: wOf(it) }] });
      }
    } else {
      acts.get(sk)!.push({
        subjectKey: sk,
        gain: fresh.reduce((t, it) => t + wOf(it) * (target - prior), 0),
        cost: NEW_COST_BASE + NEW_COST_WRONG * (1 - prior) + VARIANT_COST * (fresh.length - 1),
        items: fresh.map((it) => ({ key: it.key, w: wOf(it) })),
      });
    }
  }
  for (const l of acts.values()) l.sort((a, b) => b.gain / b.cost - a.gain / a.cost);

  /**
   * 가용량 cap으로 투영. 과목 배분은 "가장 낮은 과목부터"(물 채우기) — 과락이 있는 시험이라 한 과목만 올리는 것보다
   * 고르게 올리는 쪽이 합격 확률이 높다(plan.ts의 합격 확률 기여도와 같은 방향). 실기기 v0.6.0: 효율이 같으면 앞 과목만
   * 88.8점까지 채우고 나머지 셋은 45점에 두는 비현실적 배분이 나왔다
   */
  const start = () => ({ score: new Map(fc.subjects.map((s) => [s.key, s.score])), pos: new Map(fc.subjects.map((s) => [s.key, 0])), used: 0, learned: new Set<string>() });
  type St = ReturnType<typeof start>;
  const take = (st: St, sk: string, cap: number): boolean => {
    const l = acts.get(sk)!;
    const i = st.pos.get(sk)!;
    if (i >= l.length || st.used + l[i].cost > cap + 1e-9) return false;
    st.used += l[i].cost;
    st.score.set(sk, st.score.get(sk)! + l[i].gain);
    st.pos.set(sk, i + 1);
    for (const x of l[i].items) st.learned.add(x.key);
    return true;
  };
  const avgOf = (st: St) => [...st.score.values()].reduce((a, b) => a + b, 0) / Math.max(1, st.score.size);
  const run = (st: St, cap: number, subjT: number, avgT: number) => {
    for (;;) {
      const scores = [...st.score];
      // 무한 가용량(필요 시간 계산): 모든 과목 ≥ 과목 목표, 평균 ≥ 평균 목표에 닿으면 멈춘다
      if (cap === Infinity && scores.every(([, v]) => v >= subjT - 1e-9) && avgOf(st) >= avgT - 1e-9) break;
      // 남은 행동이 있는 과목을 낮은 순으로 — 가장 낮은 과목부터 한 행동씩
      const open = scores.filter(([k]) => st.pos.get(k)! < acts.get(k)!.length).sort((a, b) => a[1] - b[1]);
      if (!open.some(([k]) => take(st, k, cap))) break;
    }
    return st;
  };
  /** 시험 직전 복습: 이미 익힌(또는 투영에서 익힌) 문항의 시험일 정답 확률을 LATE_R까지 — 효과 큰 문항부터 1회씩 */
  const finalReview = (st: St, budget: number) => {
    const cand: { sk: string; gain: number }[] = [];
    for (const it of bank.items) {
      if (!current.has(it.subjectKey)) continue;
      const known = mem.items.has(it.key) || st.learned.has(it.key);
      if (!known) continue;
      const prior = priorOf(it.subjectKey);
      const pNow = st.learned.has(it.key) ? targetOf(it.subjectKey) : p0.get(it.key)!;
      const g = wOf(it) * (LATE_R + (1 - LATE_R) * prior - pNow);
      if (g > 0) cand.push({ sk: it.subjectKey, gain: g });
    }
    cand.sort((a, b) => b.gain - a.gain);
    let used = 0;
    for (const c of cand) {
      if (used + 1 > budget) break;
      used++;
      st.score.set(c.sk, st.score.get(c.sk)! + c.gain);
    }
    return used;
  };
  const project = (cap: number, subjT: number, avgT: number) => {
    const st = run(start(), cap, subjT, avgT);
    return { score: st.score, used: st.used, avg: avgOf(st) };
  };

  // 계획한 시간: 시험 직전 LATE_DAYS일 전까지는 익히기 → 직전 며칠은 마지막 복습 먼저, 남으면 더 익히기
  const early = run(start(), Math.max(0, capacity - lateCapacity), subjTarget, avgTarget);
  const reviewUsed = finalReview(early, lateCapacity);
  const plannedSt = run(early, early.used + (lateCapacity - reviewUsed), subjTarget, avgTarget);
  const planned = { score: plannedSt.score, used: plannedSt.used, avg: avgOf(plannedSt) };
  // 목표에 드는 풀이 횟수: 무한 가용량으로 ①·② 단계까지만. "하루 몇 분"은 남은 날(달력) 모두 공부한다고 보고 나눈다
  const perDay = (q: number) => (daysLeft > 0 ? Math.ceil((q * sec) / 60 / daysLeft) : null);
  const reach = (subjT: number, avgT: number) => {
    const p = project(Infinity, subjT, avgT);
    const ok = [...p.score.values()].every((v) => v >= subjT - 1e-9) && p.avg >= avgT - 1e-9;
    return ok ? perDay(p.used) : null;
  };
  const neededMinutesPerDay = reach(subjTarget, avgTarget);
  // 최소 시간: 여유 없이 과락선·합격선에 딱 닿는 데 필요한 시간(사용자 요청 — "남은 N일 동안 매일 최소 몇 분")
  const minMinutesPerDay = reach(rule.subjectMin, rule.avgMin);
  const coverMinutesPerDay = perDay([...acts.values()].flat().reduce((t, a) => t + a.cost, 0));
  const plannedPerDay = daysLeft > 0 ? time.minutes / daysLeft : 0;

  let subjReachable = true;
  const subjects: SubjectOutlook[] = fc.subjects.map((s) => {
    // 과목별 필요량: 그 과목 목표까지 효율 순으로
    let need = 0;
    let sc = s.score;
    for (const a of acts.get(s.key)!) {
      if (sc >= subjTarget) break;
      sc += a.gain;
      need += a.cost;
    }
    if (sc < subjTarget) subjReachable = false;
    return { key: s.key, name: s.name, now: s.score, projected: r1(planned.score.get(s.key)!), needQuestions: Math.ceil(need) };
  });
  const fixQ = subjects.reduce((a, s) => a + s.needQuestions, 0);
  const fixMinutesPerDay = subjReachable ? perDay(fixQ) : null;
  const projectedAverage = r1(planned.avg);
  const failSubjects = subjects.filter((s) => s.projected < rule.subjectMin).map((s) => s.name);
  const rough = fc.subjects.some((s) => (mem.priorObs.get(s.key) ?? 0) < OUTLOOK_MIN_OBS);
  let status: OutlookStatus;
  if (rough) status = 'unknown';
  else if (failSubjects.length) status = 'fail-subject';
  else if (projectedAverage < rule.avgMin) status = 'avg-short';
  else if (subjects.some((s) => s.projected < subjTarget) || projectedAverage < avgTarget) status = 'tight';
  else status = 'pass';
  return {
    status,
    subjects,
    projectedAverage,
    failSubjects,
    studyDays: Math.round(time.days * 10) / 10,
    plannedMinutes: Math.round(time.minutes),
    daysLeft,
    neededMinutesPerDay,
    minMinutesPerDay,
    coverMinutesPerDay,
    fixMinutesPerDay,
    extraMinutesPerDay: neededMinutesPerDay == null ? Infinity : Math.max(0, Math.ceil(neededMinutesPerDay - plannedPerDay)),
    rough,
  };
}
