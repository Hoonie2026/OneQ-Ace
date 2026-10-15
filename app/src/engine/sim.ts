/**
 * 가상 학습자 시뮬레이션(개발기준서 6.6, 4단계 게이트). 시험 전용 — 앱 화면은 가져다 쓰지 않는다.
 *
 * 학습자의 "진짜 기억"은 엔진(FSRS 멱함수 망각곡선)과 **다른 모델**(지수 망각)로 둔다.
 * 엔진이 자기 가정과 같은 세계에서만 잘 되는지가 아니라, 모델이 틀려도 과락을 해소하는지 보려는 것이다.
 *
 * - 처음 보는 문항: 과목 실력 a_s 확률로 맞힘(찍기·부분 지식 포함)
 * - 한 번 본 문항(정답 확인 후): 기억 R(t) = 0.9^(t/S) — S일 뒤 90%(FSRS와 같은 S 정의, 곡선 모양만 다름)
 *   정답 확률 = R + (1 − R)·a_s
 * - 첫 노출 후 S = (맞힘 3일 / 틀림 1일)·f, 다음 날 이후 다시 풀어 맞히면 S ← S·(1.5 + 8·(1 − R))·√f(간격 효과),
 *   틀리면 S ← max(0.5, 0.3·S). f = 망각 계수(망각형 0.5)
 * - 시험 점수(진짜) = 과목 문항마다 R(T) + (1 − R(T))·a_s의 평균
 */
import { addDays, DAY_MS, formatDate, parseDate, startOfDay } from './days';
import { buildBank, type Bank } from './items';
import { replay, type MemoryState } from './memory';
import { hasOverride, minutesToday } from './minutes';
import { passOutlook, type OutlookStatus } from './outlook';
import { forecast } from './predict';
import { planWeek, type WeeklyPlan } from './plan';
import { buildTodaySession, retryTail } from './session';
import { rng } from './mock';
import { DEFAULT_PLAN_SETTINGS, type EngineAttempt, type EngineQuestion, type PlanSettings } from './types';

export const SUBJECTS = ['측지학 및 위성측위시스템', '응용측량', '사진측량 및 원격탐사', '지리정보시스템', '측량학'];

/** 실측(측량 34회차)과 비슷한 문제 은행: 회차 rounds개 × 과목 5 × 20문항, 약 9%가 다른 회차와 같은 문항 */
export function syntheticBank(rounds = 30, seed = 7): EngineQuestion[] {
  const rand = rng(seed);
  const out: EngineQuestion[] = [];
  const pool: string[][] = SUBJECTS.map(() => []);
  for (let r = 0; r < rounds; r++) {
    const year = 2011 + Math.floor(r / 3);
    const date = `${year}-${String(3 + (r % 3) * 3).padStart(2, '0')}-10`;
    const packId = `SIM-${year}-${(r % 3) + 1}`;
    for (let s = 0; s < SUBJECTS.length; s++) {
      for (let k = 0; k < 20; k++) {
        const no = s * 20 + k + 1;
        let body: string;
        if (pool[s].length > 20 && rand() < 0.09) body = pool[s][Math.floor(rand() * pool[s].length)];
        else {
          body = `${SUBJECTS[s]} 문제 ${r}-${k} 다음 중 옳은 것은? ① 가${r}${k} ② 나${r}${k} ③ 다${r}${k} ④ 라${r}${k}`;
          pool[s].push(body);
        }
        out.push({ qid: `${packId}-${String(no).padStart(3, '0')}`, packId, examDate: date, subjectName: SUBJECTS[s], text: `${no}. ${body}`, clusterId: null });
      }
    }
  }
  return out;
}

export interface Learner {
  name: string;
  ability: number[]; // 과목별 a_s
  forget: number; // f
  dailyMinutes: number;
  secPerQ: number;
}

export const LEARNERS: Learner[] = [
  { name: '균형형(전 과목 45%)', ability: [0.45, 0.45, 0.45, 0.45, 0.45], forget: 1, dailyMinutes: 60, secPerQ: 90 },
  { name: '과락형(한 과목 20%)', ability: [0.55, 0.55, 0.2, 0.55, 0.55], forget: 1, dailyMinutes: 60, secPerQ: 90 },
  { name: '망각형(전 과목 35%, 빨리 잊음)', ability: [0.35, 0.35, 0.35, 0.35, 0.35], forget: 0.5, dailyMinutes: 90, secPerQ: 90 },
];

interface TrueMem {
  S: number;
  last: number;
}

class World {
  mem = new Map<string, TrueMem>(); // 내용(동일 문항 묶음) 단위로 기억
  readonly learner: Learner;
  readonly bank: Bank;
  readonly subjIndex: Map<string, number>;
  readonly rand: () => number;
  constructor(learner: Learner, bank: Bank, subjIndex: Map<string, number>, rand: () => number) {
    this.learner = learner;
    this.bank = bank;
    this.subjIndex = subjIndex;
    this.rand = rand;
  }
  ability(qid: string) {
    return this.learner.ability[this.subjIndex.get(this.bank.itemOf.get(qid)!.subjectKey)!];
  }
  recall(key: string, t: number) {
    const m = this.mem.get(key);
    return m ? Math.pow(0.9, (t - m.last) / DAY_MS / m.S) : 0;
  }
  pCorrect(qid: string, t: number) {
    const r = this.recall(this.bank.itemOf.get(qid)!.key, t);
    return r + (1 - r) * this.ability(qid);
  }
  answer(qid: string, t: number): boolean {
    const key = this.bank.itemOf.get(qid)!.key;
    const r = this.recall(key, t);
    const ok = this.rand() < r + (1 - r) * this.ability(qid);
    const f = this.learner.forget;
    const m = this.mem.get(key);
    if (!m) this.mem.set(key, { S: (ok ? 3 : 1) * f, last: t });
    else {
      const sameDay = startOfDay(m.last) === startOfDay(t);
      if (!sameDay) m.S = ok ? m.S * (1.5 + 8 * (1 - r)) * Math.sqrt(f) : Math.max(0.5, 0.3 * m.S);
      m.last = t;
    }
    return ok;
  }
  /** 진짜 시험 점수(과목별, 보유 문항 기준) */
  examScores(T: number): number[] {
    const sum = SUBJECTS.map(() => 0);
    const n = SUBJECTS.map(() => 0);
    for (const it of this.bank.items) {
      const s = this.subjIndex.get(it.subjectKey)!;
      const p = this.pCorrect(it.qids[0], T);
      sum[s] += p * it.qids.length;
      n[s] += it.qids.length;
    }
    return sum.map((x, i) => (100 * x) / n[i]);
  }
}

export interface SimResult {
  learner: string;
  days: number;
  policy: 'engine' | 'sequential' | 'focus';
  response: Response;
  start: number[]; // 시작 시 진짜 점수
  final: number[]; // 시험일 진짜 점수
  predictedFinal: number[] | null; // 시험 전날 엔진 예상 점수
  attempts: number;
  /** 과목별 풀이 수(첫 풀이 / 전체 / 첫 풀이 정답) */
  bySubject: { first: number; all: number; firstOk: number }[];
  shortageAtStart: boolean;
  firstPlan: WeeklyPlan | null;
  /** 날마다 실제로 쓴 학습시간(분) — 비교 기준에 같은 시간을 준다 */
  minutesByDay: number[];
  /** 합격 기준 경고: 날마다의 상태(엔진만) */
  outlooks: { d: number; status: OutlookStatus; needed: number | null; projectedAvg: number }[];
  /** 위기 대응을 시작한 날(시험까지 남은 날), 마지막 날들에 3시간을 넘겨 공부한 날 수와 그중 가장 긴 날(분) */
  crisisFromDaysLeft: number | null;
  pushDays: number;
  pushMaxMinutes: number;
}

/**
 * 학습자가 경고에 어떻게 반응하는가.
 * - fixed: 처음 정한 하루 학습시간 그대로(기준서 6.6 원래 시나리오)
 * - crisis: **위기 대응형**(사용자가 밝힌 실제 학습 행동 — ADR 007). 시험 14일 전부터 합격이 불투명하면(경고 ≠ 합격)
 *   하루 학습시간을 최소 2시간, 필요하면 3시간까지 늘리고(한 번 늘리면 줄이지 않음), 시험 1~2일 전에도 불투명하면
 *   경고가 알려 주는 "남은 날 매일 필요한 시간"만큼(하루 최대 8시간) 공부한다(사용자: 연차를 내서라도). 위기 구간에는 일요일도 공부한다
 */
export type Response = 'fixed' | 'crisis';
export const CRISIS = { fromDaysLeft: 14, minMinutes: 120, maxMinutes: 180, finalDaysLeft: 2, finalMaxMinutes: 480 };

const START = parseDate('2027-01-04'); // 월요일

export interface SimOptions {
  policy?: 'engine' | 'sequential' | 'focus';
  seed?: number;
  response?: Response;
  /** 날마다 학습시간(분)을 정해 준다(비교 기준이 엔진 학습자와 같은 시간을 쓰게) */
  minutesByDay?: number[];
  onDay?: (d: number, plan: WeeklyPlan, bank: Bank, today: string[], mem: MemoryState) => void;
}

/**
 * @param policy 'engine' = 매일 계획 엔진의 오늘 학습, 'sequential' = 비교 기준(회차 순서대로 풀고 틀린 것만 그날 다시),
 *   'focus' = 참고용 상한(실력을 아는 사람이 가장 약한 과목만 회차 순서대로)
 */
export function simulate(learner: Learner, days: number, opts: SimOptions = {}): SimResult {
  const { policy = 'engine', seed = 1, response = 'fixed', onDay } = opts;
  const questions = syntheticBank();
  const bank = buildBank(questions);
  const subjIndex = new Map(bank.subjects.map((s) => [s.key, SUBJECTS.indexOf(s.name)]));
  const world = new World(learner, bank, subjIndex, rng(seed));
  const examDate = formatDate(addDays(START, days));
  const T = parseDate(examDate) + 9 * 3_600_000;
  const settings: PlanSettings = { ...DEFAULT_PLAN_SETTINGS, examDate, dailyMinutes: learner.dailyMinutes, studyDaysPerWeek: 6, dayMinutes: {} };
  const attempts: EngineAttempt[] = [];
  const weakest = learner.ability.indexOf(Math.min(...learner.ability));
  const order = [...questions]
    .filter((q) => policy !== 'focus' || q.subjectName === SUBJECTS[weakest]).sort((a, b) => (a.examDate === b.examDate ? a.qid.localeCompare(b.qid) : a.examDate < b.examDate ? -1 : 1)).map((q) => q.qid);
  let cursor = 0;
  let firstPlan: WeeklyPlan | null = null;
  let shortageAtStart = false;
  const start = world.examScores(T);
  const minutesByDay: number[] = [];
  const outlooks: SimResult['outlooks'] = [];
  let crisisMinutes = 0;
  let crisisFromDaysLeft: number | null = null;
  let pushDays = 0;
  let pushMaxMinutes = 0;

  for (let d = 0; d < days; d++) {
    const day = addDays(START, d);
    const daysLeft = days - d;
    let t = day + 9 * 3_600_000;
    let mem: MemoryState | null = null;
    if (policy === 'engine') {
      mem = replay(bank, attempts);
      const ol = passOutlook(bank, mem, settings, t);
      outlooks.push({ d, status: ol.status, needed: ol.neededMinutesPerDay, projectedAvg: ol.projectedAverage });
      if (response === 'crisis' && daysLeft <= CRISIS.fromDaysLeft && ol.status !== 'pass') {
        // 불투명: 필요한 만큼(최소 2시간, 최대 3시간), 한 번 늘리면 줄이지 않는다. 남은 날 전체에 적용
        const want = Math.min(CRISIS.maxMinutes, Math.max(CRISIS.minMinutes, ol.neededMinutesPerDay ?? CRISIS.maxMinutes));
        if (want > crisisMinutes) {
          crisisMinutes = want;
          crisisFromDaysLeft ??= daysLeft;
          for (let k = d; k < days; k++) {
            const key = formatDate(addDays(START, k));
            settings.dayMinutes![key] = Math.max(settings.dayMinutes![key] ?? 0, crisisMinutes);
          }
        }
        // 시험 1~2일 전: 남은 날 매일 필요한 시간만큼(하루 최대 8시간)
        if (daysLeft <= CRISIS.finalDaysLeft) {
          const need = Math.min(CRISIS.finalMaxMinutes, ol.neededMinutesPerDay ?? CRISIS.finalMaxMinutes);
          const key = formatDate(day);
          if (need > (settings.dayMinutes![key] ?? 0)) {
            settings.dayMinutes![key] = need;
            pushDays++;
            pushMaxMinutes = Math.max(pushMaxMinutes, need);
          }
        }
      }
    }
    const isSunday = new Date(day).getDay() === 0;
    let minutes: number;
    if (opts.minutesByDay) minutes = opts.minutesByDay[d] ?? 0;
    else minutes = isSunday && !hasOverride(settings, day) ? 0 : minutesToday(settings, day);
    minutesByDay.push(minutes);
    if (minutes <= 0) continue;
    const solve = (qid: string) => {
      const ok = world.answer(qid, t);
      const jitter = 0.7 + 0.6 * world.rand();
      attempts.push({ qid, ts: t, correct: ok, chosen: ok ? 1 : 2, unsure: false, elapsedMs: Math.round(learner.secPerQ * 1000 * jitter) });
      t += learner.secPerQ * 1000;
      return ok;
    };
    const perDay = Math.floor((minutes * 60) / learner.secPerQ);
    let budget = perDay;
    if (policy === 'engine') {
      const plan = planWeek({ bank, mem: mem!, attempts, settings, now: t });
      if (!firstPlan) {
        firstPlan = plan;
        shortageAtStart = plan.shortage != null;
      }
      // 세션(15문항)을 하루 학습량만큼 이어서. 틀린 것은 세션 끝에 한 번 더(학습량에 포함)
      const entries = buildTodaySession(plan, startOfDay(t), perDay);
      onDay?.(d, plan, bank, entries.map((e) => e.subjectKey + ':' + e.slot), mem!);
      for (let i = 0; i < entries.length && budget > 0; i += 15) {
        const chunk = entries.slice(i, i + 15);
        const wrong = new Set<string>();
        for (const e of chunk) {
          if (budget-- <= 0) break;
          if (!solve(e.qid)) wrong.add(e.qid);
        }
        for (const e of retryTail(chunk, wrong)) {
          if (budget-- <= 0) break;
          solve(e.qid);
        }
      }
    } else {
      const wrong: string[] = [];
      while (budget > 0) {
        const qid = order[cursor++ % order.length];
        budget--;
        if (!solve(qid)) wrong.push(qid);
        if (wrong.length >= 15 || budget === 0) {
          for (const w of wrong.splice(0)) {
            if (budget-- <= 0) break;
            solve(w);
          }
        }
      }
    }
  }
  let predictedFinal: number[] | null = null;
  if (policy === 'engine') {
    const fc = forecast(bank, replay(bank, attempts), examDate, settings.passRule, settings.safetyMargin);
    predictedFinal = SUBJECTS.map((n) => fc.subjects.find((s) => s.name === n)!.score);
  }
  const bySubject = SUBJECTS.map(() => ({ first: 0, all: 0, firstOk: 0 }));
  const seen = new Set<string>();
  for (const a of attempts) {
    const it = bank.itemOf.get(a.qid)!;
    const b = bySubject[subjIndex.get(it.subjectKey)!];
    b.all++;
    if (!seen.has(it.key)) {
      seen.add(it.key);
      b.first++;
      if (a.correct) b.firstOk++;
    }
  }
  return { learner: learner.name, days, policy, response, start, final: world.examScores(T), predictedFinal, attempts: attempts.length, bySubject, shortageAtStart, firstPlan, minutesByDay, outlooks, crisisFromDaysLeft, pushDays, pushMaxMinutes };
}

/**
 * 실제 시험(과목당 n문항)에서 합격할 확률. 과목마다 정답 수 ~ 이항(n, 점수/100), 과목끼리 독립으로 보고
 * "모든 과목 ≥ 과락선 그리고 전체 ≥ 평균 합격선"의 확률을 정확히 계산한다(정답 수 분포의 합성곱).
 * 게이트 조건 2의 비교 척도(ADR 007): 평균 점수는 과락을 감수하고 강한 과목만 올려도 높아지기 때문
 */
export function passProbability(scores: number[], n = 20, subjectMin = 40, avgMin = 60): number {
  const minC = Math.ceil((subjectMin / 100) * n - 1e-9);
  let dist = [1]; // 지금까지 과목의 정답 수 합 분포(모든 과목이 과락선 이상인 경우만)
  for (const sc of scores) {
    const p = Math.min(1, Math.max(0, sc / 100));
    const b: number[] = [];
    let c = Math.pow(1 - p, n); // C(n,0) p^0 (1-p)^n
    for (let k = 0; k <= n; k++) {
      if (k > 0) c = p >= 1 ? (k === n ? 1 : 0) : (c * (n - k + 1) * p) / (k * (1 - p));
      b.push(k >= minC ? c : 0);
    }
    if (p >= 1) b.fill(0), (b[n] = 1);
    const next = new Array(dist.length + n).fill(0);
    for (let i = 0; i < dist.length; i++) if (dist[i]) for (let k = 0; k <= n; k++) next[i + k] += dist[i] * b[k];
    dist = next;
  }
  const need = Math.ceil((avgMin / 100) * n * scores.length - 1e-9);
  return dist.slice(need).reduce((a, x) => a + x, 0);
}
