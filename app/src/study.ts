/**
 * 풀이 묶음(run)과 채점 기록. 4단계 학습 엔진이 들어오기 전의 단순한 풀이 흐름:
 * 회차 전체(순서대로), 과목별, 이 회차의 오답·모름 다시 풀기.
 */
import { db as defaultDb, newId, safeWrite, type AttemptMode, type AttemptRow, type OneQDB, type QuestionRow, type RunRow } from './db';

export const MODE_LABEL: Record<AttemptMode, string> = { round: '회차 전체', subject: '과목별', wrong: '오답·모름' };

export function isCorrect(q: Pick<QuestionRow, 'answer' | 'acceptAlso'>, chosen: number): boolean {
  return chosen !== 0 && (chosen === q.answer || (q.acceptAlso ?? []).includes(chosen));
}

/** 문항별 가장 최근 풀이 */
export async function latestByQid(qids: string[], d: OneQDB = defaultDb): Promise<Map<string, AttemptRow>> {
  const rows = await d.attempts.where('qid').anyOf(qids).toArray();
  const m = new Map<string, AttemptRow>();
  for (const a of rows) {
    const cur = m.get(a.qid);
    if (!cur || a.ts > cur.ts) m.set(a.qid, a);
  }
  return m;
}

export async function startRun(
  packId: string,
  mode: AttemptMode,
  opts: { subjectNo?: number; now?: number } = {},
  d: OneQDB = defaultDb,
): Promise<RunRow | null> {
  const pack = await d.packs.get(packId);
  if (!pack) return null;
  let qs = (await d.questions.where('packId').equals(packId).toArray()).sort((a, b) => a.no - b.no);
  let title = `${examLabel(pack.manifest)} ${MODE_LABEL[mode]}`;
  if (mode === 'subject') {
    qs = qs.filter((q) => q.subjectNo === opts.subjectNo);
    const s = pack.manifest.subjects.find((x) => x.no === opts.subjectNo);
    title = `${examLabel(pack.manifest)} ${opts.subjectNo}과목 ${s?.name ?? ''}`.trim();
  } else if (mode === 'wrong') {
    const latest = await latestByQid(qs.map((q) => q.qid), d);
    qs = qs.filter((q) => {
      const a = latest.get(q.qid);
      return a && !a.correct;
    });
  }
  if (!qs.length) return null;
  const now = opts.now ?? Date.now();
  const run: RunRow = {
    sessionId: newId(),
    packId,
    mode,
    title,
    qids: qs.map((q) => q.qid),
    index: 0,
    answered: {},
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  await safeWrite('풀이 시작', async () => {
    // 같은 팩·같은 방식의 끝나지 않은 풀이는 하나만 둔다(새로 시작하면 이전 것은 종료 처리)
    await d.transaction('rw', d.runs, async () => {
      const open = await d.runs.where('packId').equals(packId).filter((r) => r.mode === mode && !r.finishedAt).toArray();
      for (const r of open) await d.runs.put({ ...r, finishedAt: now });
      await d.runs.put(run);
    });
  });
  return run;
}

/** 이어 풀 수 있는 풀이(팩·방식별 가장 최근 미완료) */
export async function openRuns(d: OneQDB = defaultDb): Promise<RunRow[]> {
  return (await d.runs.toArray()).filter((r) => !r.finishedAt).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function recordAnswer(
  run: RunRow,
  q: QuestionRow,
  chosen: number,
  elapsedMs: number,
  opts: { now?: number } = {},
  d: OneQDB = defaultDb,
): Promise<{ run: RunRow; attempt: AttemptRow }> {
  const now = opts.now ?? Date.now();
  const attempt: AttemptRow = {
    uid: newId(),
    qid: q.qid,
    contentHash: q.contentHash,
    ts: now,
    chosen,
    correct: isCorrect(q, chosen),
    unsure: false,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    mode: run.mode,
    sessionId: run.sessionId,
  };
  const next: RunRow = { ...run, answered: { ...run.answered, [q.qid]: attempt.uid }, updatedAt: now };
  await safeWrite('풀이 기록', () =>
    d.transaction('rw', d.attempts, d.runs, async () => {
      attempt.id = await d.attempts.add(attempt);
      await d.runs.put(next);
    }),
  );
  return { run: next, attempt };
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

export async function moveRun(run: RunRow, index: number, d: OneQDB = defaultDb): Promise<RunRow> {
  const next = { ...run, index: Math.max(0, Math.min(index, run.qids.length - 1)), updatedAt: Date.now() };
  await safeWrite('진행 위치 저장', () => d.runs.put(next));
  return next;
}

export async function finishRun(run: RunRow, d: OneQDB = defaultDb): Promise<RunRow> {
  const next = { ...run, finishedAt: Date.now(), updatedAt: Date.now() };
  await safeWrite('풀이 종료', () => d.runs.put(next));
  return next;
}

export interface SubjectScore {
  no: number;
  name: string;
  total: number;
  answered: number;
  correct: number;
  unknown: number;
  score: number; // 0~100, 이 묶음에 든 그 과목 문항 기준
}

export interface RunResult {
  total: number;
  answered: number;
  correct: number;
  wrong: number;
  unknown: number;
  subjects: SubjectScore[];
  average: number;
  /** 회차 전체를 다 풀었을 때만 합격 기준 판정 */
  verdict: 'pass' | 'fail-subject' | 'fail-average' | null;
  wrongQids: string[];
}

export async function runResult(run: RunRow, d: OneQDB = defaultDb): Promise<RunResult> {
  const pack = await d.packs.get(run.packId);
  const qs = (await d.questions.bulkGet(run.qids)).filter((q): q is QuestionRow => !!q);
  const uids = Object.values(run.answered);
  const atts = await d.attempts.where('uid').anyOf(uids).toArray();
  const byQid = new Map(atts.map((a) => [a.qid, a]));
  const subjects = new Map<number, SubjectScore>();
  for (const s of pack?.manifest.subjects ?? []) {
    subjects.set(s.no, { no: s.no, name: s.name, total: 0, answered: 0, correct: 0, unknown: 0, score: 0 });
  }
  const res: RunResult = { total: qs.length, answered: 0, correct: 0, wrong: 0, unknown: 0, subjects: [], average: 0, verdict: null, wrongQids: [] };
  for (const q of qs) {
    const s = subjects.get(q.subjectNo)!;
    s.total++;
    const a = byQid.get(q.qid);
    if (!a) continue;
    res.answered++;
    s.answered++;
    if (a.correct) {
      res.correct++;
      s.correct++;
    } else {
      res.wrongQids.push(q.qid);
      if (a.chosen === 0) {
        res.unknown++;
        s.unknown++;
      } else res.wrong++;
    }
  }
  res.subjects = [...subjects.values()].filter((s) => s.total > 0);
  for (const s of res.subjects) s.score = Math.round((s.correct / s.total) * 1000) / 10;
  res.average = res.subjects.length ? Math.round((res.subjects.reduce((x, s) => x + s.score, 0) / res.subjects.length) * 10) / 10 : 0;
  if (pack && run.mode === 'round' && res.answered === res.total) {
    const { subjectMin, avgMin } = pack.manifest.passRule;
    res.verdict = res.subjects.some((s) => s.score < subjectMin) ? 'fail-subject' : res.average < avgMin ? 'fail-average' : 'pass';
  }
  return res;
}

export interface PackProgress {
  packId: string;
  total: number;
  solved: number; // 1회 이상 푼 문항
  wrongNow: number; // 가장 최근 풀이가 오답·모름인 문항
}

export async function packProgress(packId: string, d: OneQDB = defaultDb): Promise<PackProgress> {
  const qids = (await d.questions.where('packId').equals(packId).primaryKeys()) as string[];
  const latest = await latestByQid(qids, d);
  let wrongNow = 0;
  for (const a of latest.values()) if (!a.correct) wrongNow++;
  return { packId, total: qids.length, solved: latest.size, wrongNow };
}

export function examLabel(m: { exam: { year: number; round: number; roundLabel?: string } }): string {
  return `${m.exam.year}년 ${m.exam.roundLabel ?? `${m.exam.round}회`}`;
}
