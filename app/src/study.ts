/**
 * 풀이 진행과 채점 기록 (ADR 003).
 *
 * - 팩마다 **회독(pass)** 하나가 진행 중이다. 회차 전체로 풀든 과목별로 풀든 같은 회독에 쌓인다.
 *   이어 풀기 = 그 회독에서 아직 안 푼 첫 문항. 진도·이어 풀기 숫자·성적이 모두 같은 값에서 나온다.
 * - 회독의 진행 상태는 저장된 목록이 아니라 원장(attempts)에서 계산한다:
 *   회독 시작 이후의 풀이(오답 다시 풀기 제외) 중 문항별 마지막 것. 따로 맞춰 둘 값이 없어 어긋날 수 없다.
 * - 오답·모름 다시 풀기는 회독과 별개의 묶음(run)이고, 다 풀면 닫힌다.
 * - DB의 runs 테이블을 그대로 쓴다: mode 'round' = 회독, 'wrong' = 오답 묶음. (v0.1.0의 'subject' 묶음은 더 쓰지 않음)
 */
import { db as defaultDb, newId, safeWrite, type AttemptMode, type AttemptRow, type OneQDB, type PackRow, type QuestionRow, type RunRow } from './db';
import { subjectKey } from './engine/items';

/**
 * 풀이 화면이 여는 대상. set = 여러 회차에 걸친 묶음(오늘 학습·모의고사 — 5단계)
 */
export type Target = { kind: 'pass'; packId: string; subjectNo?: number } | { kind: 'wrong'; sessionId: string } | { kind: 'set'; sessionId: string };

/** 회독 진도에 들어가는 풀이(회차 전체·과목별). 오답 다시 풀기·오늘 학습·모의고사는 회독과 별개 */
export const isPassAttempt = (a: Pick<AttemptRow, 'mode'>) => a.mode === 'round' || a.mode === 'subject';

export function isCorrect(q: Pick<QuestionRow, 'answer' | 'acceptAlso'>, chosen: number): boolean {
  return chosen !== 0 && (chosen === q.answer || (q.acceptAlso ?? []).includes(chosen));
}

export function examLabel(m: { exam: { year: number; round: number; roundLabel?: string } }): string {
  return `${m.exam.year}년 ${m.exam.roundLabel ?? `${m.exam.round}회`}`;
}

/** 문항별 가장 최근 풀이(조건에 맞는 것만) */
export async function latestByQid(
  qids: string[],
  d: OneQDB = defaultDb,
  keep: (a: AttemptRow) => boolean = () => true,
): Promise<Map<string, AttemptRow>> {
  const rows = await d.attempts.where('qid').anyOf(qids).toArray();
  const m = new Map<string, AttemptRow>();
  for (const a of rows) {
    if (!keep(a)) continue;
    const cur = m.get(a.qid);
    if (!cur || a.ts > cur.ts) m.set(a.qid, a);
  }
  return m;
}

async function packQuestions(packId: string, d: OneQDB): Promise<QuestionRow[]> {
  return (await d.questions.where('packId').equals(packId).toArray()).sort((a, b) => a.no - b.no);
}

// ── 회독 ─────────────────────────────────────────────

export async function currentPass(packId: string, d: OneQDB = defaultDb): Promise<RunRow | null> {
  const open = await d.runs.where('packId').equals(packId).filter((r) => r.mode === 'round' && !r.finishedAt).toArray();
  return open.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

export async function passCount(packId: string, d: OneQDB = defaultDb): Promise<number> {
  return d.runs.where('packId').equals(packId).filter((r) => r.mode === 'round').count();
}

/** 진행 중인 회독을 돌려주고, 없으면 만든다. 첫 회독은 그 전에 푼 기록(과목별 등)도 포함한다(startedAt 0) */
export async function ensurePass(packId: string, d: OneQDB = defaultDb): Promise<RunRow | null> {
  const cur = await currentPass(packId, d);
  if (cur) return cur;
  const pack = await d.packs.get(packId);
  if (!pack) return null;
  const first = (await passCount(packId, d)) === 0;
  return createPass(pack, first ? 0 : Date.now(), d);
}

async function createPass(pack: PackRow, startedAt: number, d: OneQDB): Promise<RunRow> {
  const now = Date.now();
  const qids = (await packQuestions(pack.packId, d)).map((q) => q.qid);
  const run: RunRow = {
    sessionId: newId(),
    packId: pack.packId,
    mode: 'round',
    title: examLabel(pack.manifest),
    qids,
    index: 0,
    answered: {},
    startedAt,
    updatedAt: now,
    finishedAt: null,
  };
  await safeWrite('회독 시작', () => d.runs.put(run));
  return run;
}

/** 지금 회독을 끝내고 처음부터 새 회독을 시작한다(이전 기록은 원장에 그대로) */
export async function restartPass(packId: string, d: OneQDB = defaultDb): Promise<RunRow | null> {
  const pack = await d.packs.get(packId);
  if (!pack) return null;
  const now = Date.now();
  const open = await d.runs.where('packId').equals(packId).filter((r) => r.mode === 'round' && !r.finishedAt).toArray();
  await safeWrite('회독 종료', () => d.runs.bulkPut(open.map((r) => ({ ...r, finishedAt: now, updatedAt: now }))));
  return createPass(pack, now + 1, d);
}

/** 회독에서 문항별 마지막 풀이(회독 시작 이후, 오답 다시 풀기 제외) */
export async function passAnswers(pass: RunRow, qids: string[], d: OneQDB = defaultDb): Promise<Map<string, AttemptRow>> {
  // 끝난 회독은 끝난 시각까지만(다음 회독 기록이 섞이지 않게)
  return latestByQid(qids, d, (a) => a.ts >= pass.startedAt && (pass.finishedAt == null || a.ts <= pass.finishedAt) && isPassAttempt(a));
}

// ── 오답·모름 묶음 ────────────────────────────────────

export async function openWrongRun(packId: string, d: OneQDB = defaultDb): Promise<RunRow | null> {
  const open = await d.runs.where('packId').equals(packId).filter((r) => r.mode === 'wrong' && !r.finishedAt).toArray();
  return open.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** 가장 최근 풀이가 오답·모름인 문항으로 묶음을 만든다. 끝나지 않은 묶음이 있으면 그것을 이어 푼다 */
export async function ensureWrongRun(packId: string, d: OneQDB = defaultDb): Promise<RunRow | null> {
  const open = await openWrongRun(packId, d);
  if (open) return open;
  const pack = await d.packs.get(packId);
  if (!pack) return null;
  const qs = await packQuestions(packId, d);
  const latest = await latestByQid(qs.map((q) => q.qid), d);
  const qids = qs.filter((q) => latest.get(q.qid) && !latest.get(q.qid)!.correct).map((q) => q.qid);
  if (!qids.length) return null;
  const now = Date.now();
  const run: RunRow = {
    sessionId: newId(),
    packId,
    mode: 'wrong',
    title: `${examLabel(pack.manifest)} 오답·모름`,
    qids,
    index: 0,
    answered: {},
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  await safeWrite('오답 풀이 시작', () => d.runs.put(run));
  return run;
}

// ── 풀이 화면이 쓰는 묶음 정보 ─────────────────────────

export interface Session {
  target: Target;
  run: RunRow; // 회독·오답 묶음·오늘 학습·모의고사
  /** 대표 팩(회독·오답은 그 팩, 묶음은 첫 문항의 팩) */
  pack: PackRow;
  /** 문항이 속한 팩들(묶음은 여러 회차) */
  packs: Map<string, PackRow>;
  title: string;
  qids: string[]; // 이 화면에서 풀 문항(과목별이면 그 과목만)
  answers: Map<string, AttemptRow>; // 이 묶음 기준 문항별 마지막 풀이
}

export async function loadSession(target: Target, d: OneQDB = defaultDb): Promise<Session | null> {
  if (target.kind === 'pass') {
    const pack = await d.packs.get(target.packId);
    const run = await ensurePass(target.packId, d);
    if (!pack || !run) return null;
    let qs = await packQuestions(target.packId, d);
    let title = examLabel(pack.manifest);
    if (target.subjectNo) {
      qs = qs.filter((q) => q.subjectNo === target.subjectNo);
      const s = pack.manifest.subjects.find((x) => x.no === target.subjectNo);
      title += ` ${target.subjectNo}과목 ${s?.name ?? ''}`;
    }
    const qids = qs.map((q) => q.qid);
    return { target, run, pack, packs: new Map([[pack.packId, pack]]), title: title.trim(), qids, answers: await passAnswers(run, qids, d) };
  }
  const run = await d.runs.get(target.sessionId);
  if (!run) return null;
  if (target.kind === 'wrong') {
    const pack = await d.packs.get(run.packId);
    if (!pack) return null;
    const answers = await latestByQid(run.qids, d, (a) => a.sessionId === run.sessionId);
    return { target, run, pack, packs: new Map([[pack.packId, pack]]), title: run.title, qids: run.qids, answers };
  }
  // 묶음: 지운 팩의 문항은 빼고 연다
  const qs = (await d.questions.bulkGet(run.qids)).filter((q): q is QuestionRow => !!q);
  if (!qs.length) return null;
  const packs = new Map<string, PackRow>();
  for (const id of new Set(qs.map((q) => q.packId))) {
    const p = await d.packs.get(id);
    if (p) packs.set(id, p);
  }
  const qids = qs.filter((q) => packs.has(q.packId)).map((q) => q.qid);
  if (!qids.length) return null;
  const answers = await latestByQid(qids, d, (a) => a.sessionId === run.sessionId);
  return { target, run, pack: packs.get(qs[0].packId)!, packs, title: run.title, qids, answers };
}

/** 여러 회차에 걸친 묶음(오늘 학습·모의고사)을 만든다 */
export async function createSetRun(
  certCode: string,
  mode: Extract<AttemptMode, 'today' | 'mock'>,
  title: string,
  qids: string[],
  opts: { limitSec?: number; now?: number } = {},
  d: OneQDB = defaultDb,
): Promise<RunRow> {
  const now = opts.now ?? Date.now();
  const run: RunRow = {
    sessionId: newId(),
    packId: `${certCode}-@${mode}`,
    mode,
    title,
    qids,
    index: 0,
    answered: {},
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    certCode,
    ...(opts.limitSec ? { limitSec: opts.limitSec } : {}),
  };
  await safeWrite(mode === 'mock' ? '모의고사 시작' : '오늘 학습 시작', () => d.runs.put(run));
  return run;
}

/** 묶음을 끝낸다(모의고사 제출·시간 종료) */
export async function finishRun(sessionId: string, now = Date.now(), d: OneQDB = defaultDb): Promise<void> {
  await safeWrite('풀이 끝내기', () => d.runs.update(sessionId, { finishedAt: now, updatedAt: now }));
}

/** 종목의 묶음 목록(최근 순) */
export async function setRuns(certCode: string, mode: Extract<AttemptMode, 'today' | 'mock'>, d: OneQDB = defaultDb): Promise<RunRow[]> {
  return (await d.runs.where('packId').equals(`${certCode}-@${mode}`).toArray()).sort((a, b) => b.startedAt - a.startedAt);
}

/** 이어 풀 위치: 안 푼 첫 문항. 다 풀었으면 -1 */
export function firstUnanswered(s: Pick<Session, 'qids' | 'answers'>): number {
  return s.qids.findIndex((qid) => !s.answers.has(qid));
}

export async function recordAnswer(
  s: Session,
  q: QuestionRow,
  chosen: number,
  elapsedMs: number,
  opts: { now?: number } = {},
  d: OneQDB = defaultDb,
): Promise<{ session: Session; attempt: AttemptRow }> {
  const now = opts.now ?? Date.now();
  const mode: AttemptMode = s.target.kind === 'wrong' ? 'wrong' : s.target.kind === 'set' ? s.run.mode : s.target.subjectNo ? 'subject' : 'round';
  const attempt: AttemptRow = {
    uid: newId(),
    qid: q.qid,
    contentHash: q.contentHash,
    ts: now,
    chosen,
    correct: isCorrect(q, chosen),
    unsure: false,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    mode,
    sessionId: s.run.sessionId,
  };
  const answers = new Map(s.answers).set(q.qid, attempt);
  const run: RunRow = { ...s.run, answered: { ...s.run.answered, [q.qid]: attempt.uid }, updatedAt: now };
  // 오답 묶음·오늘 학습·모의고사는 다 풀면 닫는다. 회독은 사용자가 "새 회독"을 고를 때까지 열어 둔다(결과를 계속 볼 수 있게)
  if (s.target.kind !== 'pass' && s.qids.every((x) => answers.has(x))) run.finishedAt = now;
  await safeWrite('풀이 기록', () =>
    d.transaction('rw', d.attempts, d.runs, async () => {
      attempt.id = await d.attempts.add(attempt);
      await d.runs.put(run);
    }),
  );
  return { session: { ...s, run, answers }, attempt };
}

export async function setUnsure(uid: string, unsure: boolean, d: OneQDB = defaultDb): Promise<void> {
  await safeWrite('헷갈림 표시', () => d.attempts.where('uid').equals(uid).modify({ unsure }));
}

export async function saveNote(q: QuestionRow, text: string, d: OneQDB = defaultDb): Promise<void> {
  const t = text.trim();
  const cur = await d.notes.get(q.qid);
  if ((cur?.text ?? '') === t) return; // 바뀐 것이 없으면 쓰지 않는다(지문·수정일 유지)
  await safeWrite('메모 저장', async () => {
    if (t) await d.notes.put({ qid: q.qid, contentHash: q.contentHash, text: t, updatedAt: Date.now() });
    else await d.notes.delete(q.qid);
  });
}

// ── 성적(풀이 중에도 실시간) ─────────────────────────────

export interface SubjectScore {
  no: number;
  name: string;
  total: number;
  answered: number;
  correct: number;
  unknown: number;
  /** 정답률(푼 문항 기준, 0~100). 안 푼 과목은 null */
  rate: number | null;
  /** 시험 점수(그 과목 전체 문항 기준, 안 푼 문항은 0점) */
  score: number;
}

export interface Result {
  title: string;
  total: number;
  answered: number;
  correct: number;
  wrong: number;
  unknown: number;
  subjects: SubjectScore[];
  /** 평균 점수 = 과목 점수의 평균(안 푼 문항은 0점). 예: 100문항 중 2문항 정답 → 2점 */
  avgScore: number;
  /** 합격선 판정. 회차 전체를 다 풀었을 때만(풀이 중 점수는 안 푼 문항이 0점이라 판정하지 않음) */
  verdict: 'pass' | 'fail-subject' | 'fail-average' | null;
  complete: boolean;
  wrongQids: string[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export async function sessionResult(s: Session, d: OneQDB = defaultDb): Promise<Result> {
  const qs = (await d.questions.bulkGet(s.qids)).filter((q): q is QuestionRow => !!q);
  // 과목은 과목명으로 묶는다(ADR 004 — 여러 회차에 걸친 묶음도 같은 과목끼리). 순서는 가장 최근 회차의 과목 순서
  const primary = [...s.packs.values()].sort((a, b) => (a.manifest.exam.date < b.manifest.exam.date ? 1 : -1))[0] ?? s.pack;
  const subjects = new Map<string, SubjectScore>();
  for (const sub of primary.manifest.subjects) {
    subjects.set(subjectKey(sub.name), { no: sub.no, name: sub.name, total: 0, answered: 0, correct: 0, unknown: 0, rate: null, score: 0 });
  }
  const keyOf = (q: QuestionRow) => {
    const name = (s.packs.get(q.packId) ?? s.pack).manifest.subjects.find((x) => x.no === q.subjectNo)?.name ?? `${q.subjectNo}과목`;
    const k = subjectKey(name);
    if (!subjects.has(k)) subjects.set(k, { no: subjects.size + 1, name, total: 0, answered: 0, correct: 0, unknown: 0, rate: null, score: 0 });
    return k;
  };
  const res: Result = {
    title: s.title,
    total: qs.length,
    answered: 0,
    correct: 0,
    wrong: 0,
    unknown: 0,
    subjects: [],
    avgScore: 0,
    verdict: null,
    complete: false,
    wrongQids: [],
  };
  for (const q of qs) {
    const sub = subjects.get(keyOf(q))!;
    sub.total++;
    const a = s.answers.get(q.qid);
    if (!a) continue;
    res.answered++;
    sub.answered++;
    if (a.correct) {
      res.correct++;
      sub.correct++;
    } else {
      res.wrongQids.push(q.qid);
      if (a.chosen === 0) {
        res.unknown++;
        sub.unknown++;
      } else res.wrong++;
    }
  }
  res.subjects = [...subjects.values()].filter((x) => x.total > 0);
  for (const x of res.subjects) {
    x.rate = x.answered ? r1((x.correct / x.answered) * 100) : null;
    x.score = r1((x.correct / x.total) * 100);
  }
  res.avgScore = res.subjects.length ? r1(res.subjects.reduce((t, x) => t + x.score, 0) / res.subjects.length) : 0;
  res.complete = res.answered === res.total && res.total > 0;
  // 합격선 판정: 회차 전체를 다 풀었을 때, 그리고 모의고사는 제출(시간 종료 포함)하면 — 안 푼 문항은 0점
  const mockDone = s.run.mode === 'mock' && (res.complete || s.run.finishedAt != null);
  if (((s.target.kind === 'pass' && !s.target.subjectNo && res.complete) || mockDone) && res.subjects.length) {
    const { subjectMin, avgMin } = primary.manifest.passRule;
    res.verdict = res.subjects.some((x) => x.score < subjectMin) ? 'fail-subject' : res.avgScore < avgMin ? 'fail-average' : 'pass';
  }
  return res;
}

// ── 홈 화면 요약 ──────────────────────────────────────

export interface PackSummary {
  pack: PackRow;
  pass: RunRow | null;
  passNo: number; // n회독 (진행 중인 것 포함)
  total: number;
  answered: number; // 지금 회독에서 푼 문항
  bySubject: Map<number, { answered: number; total: number }>;
  wrongNow: number; // 가장 최근 풀이가 오답·모름인 문항
  wrongRun: RunRow | null;
  wrongRunLeft: number;
  lastActivity: number;
}

export async function packSummary(pack: PackRow, d: OneQDB = defaultDb): Promise<PackSummary> {
  const qs = await packQuestions(pack.packId, d);
  const qids = qs.map((q) => q.qid);
  const pass = await currentPass(pack.packId, d);
  const answers = pass ? await passAnswers(pass, qids, d) : await latestByQid(qids, d, isPassAttempt);
  const latest = await latestByQid(qids, d);
  const bySubject = new Map<number, { answered: number; total: number }>();
  for (const q of qs) {
    const b = bySubject.get(q.subjectNo) ?? { answered: 0, total: 0 };
    b.total++;
    if (answers.has(q.qid)) b.answered++;
    bySubject.set(q.subjectNo, b);
  }
  let wrongNow = 0;
  for (const a of latest.values()) if (!a.correct) wrongNow++;
  const wrongRun = await openWrongRun(pack.packId, d);
  const wrongDone = wrongRun ? (await latestByQid(wrongRun.qids, d, (a) => a.sessionId === wrongRun.sessionId)).size : 0;
  const passes = await passCount(pack.packId, d);
  return {
    pack,
    pass,
    passNo: pass ? passes : passes + 1,
    total: qs.length,
    answered: answers.size,
    bySubject,
    wrongNow,
    wrongRun,
    wrongRunLeft: wrongRun ? wrongRun.qids.length - wrongDone : 0,
    lastActivity: Math.max(pass?.updatedAt ?? 0, wrongRun?.updatedAt ?? 0),
  };
}

// ── 회독 이력(같은 회차를 여러 번 풀었을 때 누적) ──────────

export interface PassRecord {
  passNo: number;
  sessionId: string;
  startedAt: number; // 첫 회독은 첫 풀이 시각
  finishedAt: number | null;
  answered: number;
  total: number;
  avgScore: number;
  subjectScores: number[];
  verdict: Result['verdict'];
}

export async function passHistory(packId: string, d: OneQDB = defaultDb): Promise<PassRecord[]> {
  const pack = await d.packs.get(packId);
  if (!pack) return [];
  const passes = (await d.runs.where('packId').equals(packId).filter((r) => r.mode === 'round').toArray()).sort((a, b) => a.startedAt - b.startedAt);
  const qids = (await packQuestions(packId, d)).map((q) => q.qid);
  const out: PassRecord[] = [];
  for (const [i, run] of passes.entries()) {
    const answers = await passAnswers(run, qids, d);
    const res = await sessionResult({ target: { kind: 'pass', packId }, run, pack, packs: new Map([[pack.packId, pack]]), title: '', qids, answers }, d);
    const first = Math.min(...[...answers.values()].map((a) => a.ts));
    out.push({
      passNo: i + 1,
      sessionId: run.sessionId,
      startedAt: run.startedAt || (Number.isFinite(first) ? first : run.updatedAt),
      finishedAt: run.finishedAt,
      answered: res.answered,
      total: res.total,
      avgScore: res.avgScore,
      subjectScores: res.subjects.map((x) => x.score),
      verdict: res.verdict,
    });
  }
  return out;
}
