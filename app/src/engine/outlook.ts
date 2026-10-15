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
import { examTime, forecast } from './predict';
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
  /** 과락만 벗어나는 데(모든 과목 ≥ 과락선 + 여유/2) 필요한 하루 평균 학습시간(분). 문항이 모자라면 null */
  fixMinutesPerDay: number | null;
  /** 과목 진단이 덜 돼(과목당 첫 풀이 OUTLOOK_MIN_OBS건 미만) 투영이 거친가 */
  rough: boolean;
}

interface Action {
  subjectKey: string;
  gain: number; // 과목 점수 상승(점)
  cost: number; // 풀이 횟수
}

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
  const sec = mem.secPerQuestion;
  const capacity = (time.minutes * 60) / sec;

  const fc = forecast(bank, mem, settings.examDate, rule, m);
  const current = new Set(fc.subjects.map((s) => s.key));
  const nS = bank.questionCount;

  // 과목별 행동 목록(효율 높은 순)
  const acts = new Map<string, Action[]>(fc.subjects.map((s) => [s.key, []]));
  for (const it of bank.items) {
    if (!current.has(it.subjectKey)) continue;
    const prior = mem.prior.get(it.subjectKey) ?? 0.25;
    const target = LEARNED_R + (1 - LEARNED_R) * prior;
    const w = (it.qids.length * 100) / (nS.get(it.subjectKey) ?? 1);
    const im = mem.items.get(it.key);
    if (!im) {
      acts.get(it.subjectKey)!.push({ subjectKey: it.subjectKey, gain: w * (target - prior), cost: NEW_COST_BASE + NEW_COST_WRONG * (1 - prior) });
    } else {
      const r = recallAt(im.card, T, mem.curve);
      const p = r + (1 - r) * prior;
      if (target > p) {
        const rNow = recallAt(im.card, now, mem.curve);
        acts.get(it.subjectKey)!.push({ subjectKey: it.subjectKey, gain: w * (target - p), cost: 1 + (1 - (rNow + (1 - rNow) * prior)) });
      }
    }
  }
  for (const l of acts.values()) l.sort((a, b) => b.gain / b.cost - a.gain / a.cost);

  /** 가용량 cap으로 투영: ① 과목 목표 미달 과목(깊은 순) ② 평균 목표 ③ 남는 시간은 효율 순 */
  const project = (cap: number, subjTarget: number, avgTarget: number) => {
    const score = new Map(fc.subjects.map((s) => [s.key, s.score]));
    const pos = new Map(fc.subjects.map((s) => [s.key, 0]));
    let used = 0;
    const take = (sk: string): boolean => {
      const l = acts.get(sk)!;
      const i = pos.get(sk)!;
      if (i >= l.length || used + l[i].cost > cap + 1e-9) return false;
      used += l[i].cost;
      score.set(sk, score.get(sk)! + l[i].gain);
      pos.set(sk, i + 1);
      return true;
    };
    // ① 가장 낮은 과목부터 한 문항씩(깊은 과목에 먼저, 여러 과목이 미달이면 번갈아)
    for (;;) {
      const below = [...score].filter(([k, v]) => v < subjTarget && pos.get(k)! < acts.get(k)!.length).sort((a, b) => a[1] - b[1]);
      if (!below.length || !take(below[0][0])) break;
    }
    // ② 평균 목표까지, 그다음은 ③ 시간이 남는 만큼 — 둘 다 전 과목 효율 순
    const avg = () => [...score.values()].reduce((a, b) => a + b, 0) / Math.max(1, score.size);
    for (;;) {
      let best: string | null = null;
      let eff = -1;
      for (const [k, l] of acts) {
        const a = l[pos.get(k)!];
        if (a && a.gain / a.cost > eff) {
          eff = a.gain / a.cost;
          best = k;
        }
      }
      if (!best || (cap === Infinity && avg() >= avgTarget) || !take(best)) break;
    }
    return { score, used, avg: avg() };
  };

  const planned = project(capacity, subjTarget, avgTarget);
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
    fixMinutesPerDay,
    extraMinutesPerDay: neededMinutesPerDay == null ? Infinity : Math.max(0, Math.ceil(neededMinutesPerDay - plannedPerDay)),
    rough,
  };
}
