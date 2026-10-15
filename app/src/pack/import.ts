/**
 * 문제팩 가져오기·삭제와 학습 기록 재연결(개발기준서 4.1·4.3, ADR 002).
 * 검증기(validate.ts)를 통과한 팩만 저장한다.
 */
import {
  db as defaultDb,
  safeWrite,
  type AttemptRow,
  type ImageRow,
  type NoteRow,
  type OneQDB,
  type OrphanRow,
  type QuestionRow,
} from '../db';
import { validatePackZip, type Issue, type PackManifest } from './validate';

export type ImportResult =
  | { status: 'invalid'; issues: Issue[] }
  | { status: 'older'; manifest: PackManifest; installedVersion: number }
  /** identical: 문항·이미지 해시까지 같은 팩(다시 저장할 필요 없음) */
  | { status: 'same'; manifest: PackManifest; installedVersion: number; identical: boolean }
  | { status: 'imported'; manifest: PackManifest; replacedVersion: number | null; bytes: number; reconcile: ReconcileReport };

export const packIdOf = (qid: string) => qid.replace(/-\d{3}$/, '');

/**
 * zip 바이트를 검사해 저장한다.
 * - 같은 packId가 이미 있으면 packVersion이 더 높을 때만 교체한다. 같은 버전은 force일 때만 다시 저장.
 * - 교체 후 학습 기록을 새 문항에 다시 잇는다(reconcile).
 */
export async function importPackBytes(
  data: Uint8Array,
  opts: { force?: boolean } = {},
  d: OneQDB = defaultDb,
): Promise<ImportResult> {
  const v = await validatePackZip(data);
  if (!v.ok) return { status: 'invalid', issues: v.issues };
  const { manifest, questions, files } = v;

  const existing = await d.packs.get(manifest.packId);
  if (existing) {
    if (existing.packVersion > manifest.packVersion) {
      return { status: 'older', manifest, installedVersion: existing.packVersion };
    }
    if (existing.packVersion === manifest.packVersion && !opts.force) {
      const sig = (m: PackManifest) => m.files.map((f) => `${f.path}:${f.sha256}`).sort().join('|');
      return { status: 'same', manifest, installedVersion: existing.packVersion, identical: sig(existing.manifest) === sig(manifest) };
    }
  }

  const qRows: QuestionRow[] = questions.map((q) => ({ ...q, packId: manifest.packId }));
  const imgRows: ImageRow[] = questions.map((q) => ({
    qid: q.qid,
    kind: 'full',
    packId: manifest.packId,
    data: new Blob([files[q.img] as BlobPart], { type: 'image/webp' }),
  }));
  const bytes = imgRows.reduce((s, r) => s + r.data.size, 0);

  await safeWrite('문제팩 저장', () =>
    d.transaction('rw', [d.packs, d.questions, d.images, d.runs], async () => {
      // 번호가 바뀐 재전처리 팩: 진행 중 풀이(runs)의 문항 목록을 contentHash로 옮긴다
      const old = await d.questions.where('packId').equals(manifest.packId).toArray();
      if (old.length) {
        const newByHash = new Map(qRows.map((q) => [q.contentHash, q.qid]));
        const newQids = new Set(qRows.map((q) => q.qid));
        const oldHash = new Map(old.map((q) => [q.qid, q.contentHash]));
        const runs = await d.runs.where('packId').equals(manifest.packId).toArray();
        for (const r of runs) {
          const map = (qid: string) => newByHash.get(oldHash.get(qid) ?? '') ?? (newQids.has(qid) ? qid : null);
          const qids = r.qids.map(map).filter((x): x is string => !!x);
          const answered: Record<string, string> = {};
          for (const [k, uid] of Object.entries(r.answered)) {
            const nk = map(k);
            if (nk) answered[nk] = uid;
          }
          await d.runs.put({ ...r, qids, answered, index: Math.min(r.index, Math.max(0, qids.length - 1)) });
        }
        await d.questions.where('packId').equals(manifest.packId).delete();
        await d.images.where('packId').equals(manifest.packId).delete();
      }
      await d.questions.bulkPut(qRows);
      await d.images.bulkPut(imgRows);
      await d.packs.put({
        packId: manifest.packId,
        packVersion: manifest.packVersion,
        manifest,
        importedAt: Date.now(),
        bytes,
      });
    }),
  );

  const report = await reconcile(d);
  return { status: 'imported', manifest, replacedVersion: existing?.packVersion ?? null, bytes, reconcile: report };
}

export async function importPackFile(file: Blob, opts: { force?: boolean } = {}, d: OneQDB = defaultDb) {
  return importPackBytes(new Uint8Array(await file.arrayBuffer()), opts, d);
}

/** 팩 삭제. 그 팩의 풀이 기록·메모는 지우지 않고 '매핑 대기'로 옮겨 두었다가 다시 가져오면 잇는다 */
export async function deletePack(packId: string, d: OneQDB = defaultDb): Promise<{ parked: number }> {
  let parked = 0;
  await safeWrite('문제팩 삭제', () =>
    d.transaction('rw', [d.packs, d.questions, d.images, d.runs, d.attempts, d.notes, d.cards, d.orphans], async () => {
      const qids = (await d.questions.where('packId').equals(packId).primaryKeys()) as string[];
      const now = Date.now();
      const attempts = await d.attempts.where('qid').anyOf(qids).toArray();
      const notes = await d.notes.where('qid').anyOf(qids).toArray();
      const cards = await d.cards.where('qid').anyOf(qids).toArray();
      const orphans: OrphanRow[] = [
        ...attempts.map((a) => toOrphan('attempt', a, a.qid, a.contentHash, 'pack-removed', now)),
        ...notes.map((n) => toOrphan('note', n, n.qid, n.contentHash, 'pack-removed', now)),
      ];
      parked = orphans.length;
      await d.orphans.bulkAdd(orphans);
      await d.attempts.bulkDelete(attempts.map((a) => a.id!));
      await d.notes.bulkDelete(notes.map((n) => n.qid));
      // cards는 원장(attempts)에서 다시 계산할 수 있으므로 보관하지 않는다
      await d.cards.bulkDelete(cards.map((c) => c.qid));
      await d.questions.where('packId').equals(packId).delete();
      await d.images.where('packId').equals(packId).delete();
      await d.runs.where('packId').equals(packId).delete();
      await d.packs.delete(packId);
    }),
  );
  return { parked };
}

function toOrphan(
  kind: OrphanRow['kind'],
  data: OrphanRow['data'],
  qid: string,
  contentHash: string,
  reason: OrphanRow['reason'],
  at: number,
): OrphanRow {
  const clean = { ...(data as object) } as OrphanRow['data'];
  if (kind === 'attempt') delete (clean as AttemptRow).id;
  return { kind, data: clean, qid, contentHash, packId: packIdOf(qid), reason, at };
}

export interface ReconcileReport {
  kept: number; // qid·contentHash 그대로 일치
  moved: number; // 같은 팩 안에서 contentHash로 다른 qid에 이음(번호 변경)
  corrected: number; // qid는 있으나 내용이 고쳐짐(contentHash 갱신)
  restored: number; // 매핑 대기에서 되살림
  orphaned: number; // 이번에 매핑 대기로 보낸 수
  pending: number; // 남은 매핑 대기 전체
}

type Resolve = { qid: string; contentHash: string; how: 'kept' | 'moved' | 'corrected' } | { reason: OrphanRow['reason'] };

/**
 * 기록(attempts·notes)과 매핑 대기(orphans)를 현재 문항에 다시 잇는다(ADR 002).
 * 순서: ① qid와 contentHash가 같으면 그대로 ② 같은 팩 안에서 contentHash가 같은 문항으로 이동(번호 변경)
 * ③ qid만 있으면 내용이 고쳐진 것으로 보고 유지 ④ 나머지는 매핑 대기.
 * contentHash 검색을 같은 팩으로 한정한다: 측량 기출은 회차 간 같은 문제가 반복되므로
 * 다른 회차의 같은 문항에 기록을 붙이면 그 회차를 풀지 않았는데 푼 것으로 잘못 집계된다.
 */
export async function reconcile(d: OneQDB = defaultDb): Promise<ReconcileReport> {
  const report: ReconcileReport = { kept: 0, moved: 0, corrected: 0, restored: 0, orphaned: 0, pending: 0 };
  await safeWrite('학습 기록 재연결', () =>
    d.transaction('rw', [d.packs, d.questions, d.attempts, d.notes, d.orphans], async () => {
      const packIds = new Set((await d.packs.toCollection().primaryKeys()) as string[]);
      const questions = await d.questions.toArray();
      const byQid = new Map(questions.map((q) => [q.qid, q]));
      const byPackHash = new Map<string, string>();
      for (const q of questions) {
        const k = `${q.packId}|${q.contentHash}`;
        if (!byPackHash.has(k)) byPackHash.set(k, q.qid);
      }
      const resolve = (qid: string, hash: string): Resolve => {
        const pid = packIdOf(qid);
        if (!packIds.has(pid)) return { reason: 'pack-missing' };
        const q = byQid.get(qid);
        if (q && q.contentHash === hash) return { qid, contentHash: hash, how: 'kept' };
        const moved = byPackHash.get(`${pid}|${hash}`);
        if (moved) return { qid: moved, contentHash: hash, how: 'moved' };
        if (q) return { qid, contentHash: q.contentHash, how: 'corrected' };
        return { reason: 'no-match' };
      };
      const now = Date.now();

      // ── 원장: attempts ──
      const attempts = await d.attempts.toArray();
      const toOrphans: OrphanRow[] = [];
      const updates: AttemptRow[] = [];
      const removeIds: number[] = [];
      for (const a of attempts) {
        const r = resolve(a.qid, a.contentHash);
        if ('reason' in r) {
          toOrphans.push(toOrphan('attempt', a, a.qid, a.contentHash, r.reason, now));
          removeIds.push(a.id!);
        } else {
          report[r.how]++;
          if (r.how !== 'kept') updates.push({ ...a, qid: r.qid, contentHash: r.contentHash });
        }
      }

      // ── 메모: notes (qid가 키라서 옮길 때 충돌하면 최신 것을 남기고 나머지는 보관) ──
      const notes = await d.notes.toArray();
      const noteOut = new Map<string, NoteRow>();
      const noteRemove: string[] = [];
      const placeNote = (n: NoteRow) => {
        const cur = noteOut.get(n.qid);
        if (!cur) noteOut.set(n.qid, n);
        else {
          const [keep, park] = cur.updatedAt >= n.updatedAt ? [cur, n] : [n, cur];
          noteOut.set(n.qid, keep);
          toOrphans.push(toOrphan('note', park, park.qid, park.contentHash, 'no-match', now));
        }
      };
      for (const n of notes) {
        const r = resolve(n.qid, n.contentHash);
        if ('reason' in r) {
          toOrphans.push(toOrphan('note', n, n.qid, n.contentHash, r.reason, now));
          noteRemove.push(n.qid);
        } else {
          if (r.qid !== n.qid) noteRemove.push(n.qid);
          placeNote({ ...n, qid: r.qid, contentHash: r.contentHash });
        }
      }

      // ── 매핑 대기에서 되살리기 ──
      const orphans = await d.orphans.toArray();
      const knownUids = new Set(attempts.map((a) => a.uid));
      const revive: AttemptRow[] = [];
      const reviveIds: number[] = [];
      for (const o of orphans) {
        if (o.kind === 'card') continue;
        const r = resolve(o.qid, o.contentHash);
        if ('reason' in r) continue;
        reviveIds.push(o.id!);
        report.restored++;
        if (o.kind === 'attempt') {
          const a = o.data as AttemptRow;
          if (knownUids.has(a.uid)) continue; // 같은 기록이 이미 원장에 있음(복원 중복)
          knownUids.add(a.uid);
          revive.push({ ...a, qid: r.qid, contentHash: r.contentHash });
        } else {
          placeNote({ ...(o.data as NoteRow), qid: r.qid, contentHash: r.contentHash });
        }
      }

      await d.attempts.bulkDelete(removeIds);
      await d.attempts.bulkPut(updates);
      await d.attempts.bulkAdd(revive);
      await d.notes.bulkDelete(noteRemove);
      await d.notes.bulkPut([...noteOut.values()]);
      await d.orphans.bulkDelete(reviveIds);
      await d.orphans.bulkAdd(toOrphans);
      report.orphaned = toOrphans.length;
      report.pending = await d.orphans.count();
    }),
  );
  return report;
}

export function describeIssues(issues: Issue[]): string {
  const head = issues.slice(0, 3).map((i) => `${i.code}: ${i.message}`);
  return head.join(' / ') + (issues.length > 3 ? ` 외 ${issues.length - 3}건` : '');
}
