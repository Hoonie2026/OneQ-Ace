/**
 * 학습 기록 백업·복원(개발기준서 4.3).
 * - 백업 = settings + attempts + notes + cards + runs + orphans (이미지·문항 제외, 문제팩은 다시 가져온다)
 * - 내보내기 기본은 다운로드(.json), 공유 시트(.txt)는 보조 (0단계 실측, C6)
 * - 복원은 합치기: 같은 기록(uid)은 건너뛰고, 문항에 잇지 못한 기록은 매핑 대기로 보관한다
 * - 기록 지문(fingerprint): 백업 전후 기록이 100% 같은지 사람이 눈으로 비교하는 값(3단계 게이트)
 */
import {
  db as defaultDb,
  getSetting,
  safeWrite,
  SETTING,
  type AttemptRow,
  type CardRow,
  type NoteRow,
  type OneQDB,
  type OrphanRow,
  type RunRow,
  type SettingRow,
} from './db';
import { reconcile, type ReconcileReport } from './pack/import';
import { deviceSummary, downloadBlob, sha256Hex, yyyymmdd } from './util';

export const BACKUP_FORMAT = 'oneq-backup';
const PLAN_PREFIX = 'plan:';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  app: string;
  device: string;
  fingerprint: Fingerprint;
  packs: { packId: string; packVersion: number; title: string }[];
  settings: SettingRow[];
  attempts: Omit<AttemptRow, 'id'>[];
  notes: NoteRow[];
  cards: CardRow[];
  runs: RunRow[];
  orphans: Omit<OrphanRow, 'id'>[];
}

export interface Fingerprint {
  attempts: number;
  notes: number;
  hash: string; // 8자리
}

/** 원장(attempts + 매핑 대기 중인 풀이)과 메모 전체를 정렬해 해시한다. 기기·저장 순서와 무관하게 같은 기록이면 같은 값 */
export async function fingerprint(d: OneQDB = defaultDb): Promise<Fingerprint> {
  const atts: AttemptRow[] = [
    ...(await d.attempts.toArray()),
    ...(await d.orphans.where('kind').equals('attempt').toArray()).map((o) => o.data as AttemptRow),
  ];
  const notes: NoteRow[] = [
    ...(await d.notes.toArray()),
    ...(await d.orphans.where('kind').equals('note').toArray()).map((o) => o.data as NoteRow),
  ];
  const lines = [
    ...atts.map((a) => `a|${a.uid}|${a.qid}|${a.ts}|${a.chosen}|${a.correct ? 1 : 0}|${a.unsure ? 1 : 0}|${a.elapsedMs}${a.easy ? '|e' : ''}`), // 쉬움(v0.9.2)은 있을 때만 붙여 이전 백업과 지문이 같게
    ...notes.map((n) => `n|${n.qid}|${n.updatedAt}|${n.text}`),
  ].sort();
  const hash = (await sha256Hex(new TextEncoder().encode(lines.join('\n')))).slice(0, 8);
  return { attempts: atts.length, notes: notes.length, hash };
}

export function formatFingerprint(f: Fingerprint): string {
  return `풀이 ${f.attempts}건 · 메모 ${f.notes}건 · 지문 ${f.hash}`;
}

export async function buildBackup(appVersion: string, d: OneQDB = defaultDb): Promise<{ data: BackupFile; json: string; name: string }> {
  const strip = <T extends { id?: number }>(r: T): Omit<T, 'id'> => {
    const { id: _id, ...rest } = r;
    return rest;
  };
  const data: BackupFile = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: appVersion,
    device: deviceSummary(),
    fingerprint: await fingerprint(d),
    packs: (await d.packs.toArray()).map((p) => ({
      packId: p.packId,
      packVersion: p.packVersion,
      title: `${p.manifest.cert.name} ${p.manifest.exam.year}년 ${p.manifest.exam.roundLabel ?? `${p.manifest.exam.round}회`}`,
    })),
    settings: (await d.settings.toArray()).filter((s) => !(Object.values(SETTING) as string[]).includes(s.key)),
    attempts: (await d.attempts.orderBy('ts').toArray()).map(strip),
    notes: await d.notes.toArray(),
    cards: await d.cards.toArray(),
    runs: await d.runs.toArray(),
    orphans: (await d.orphans.toArray()).map(strip),
  };
  return { data, json: JSON.stringify(data), name: `oneq-backup-${yyyymmdd()}.json` };
}

export async function markBackedUp(d: OneQDB = defaultDb): Promise<void> {
  const n = await d.attempts.count();
  await safeWrite('백업 시각 기록', () =>
    d.settings.bulkPut([
      { key: SETTING.lastBackupAt, value: Date.now() },
      { key: SETTING.attemptsAtLastBackup, value: n },
    ]),
  );
}

/** 홈 화면 백업 권유: 마지막 백업 후 7일 경과(새 기록이 있을 때) 또는 풀이 300건 누적 */
export async function backupDue(now = Date.now(), d: OneQDB = defaultDb): Promise<{ due: boolean; since: number | null; newAttempts: number }> {
  const count = await d.attempts.count();
  const last = await getSetting<number | null>(SETTING.lastBackupAt, null, d);
  const base = await getSetting<number>(SETTING.attemptsAtLastBackup, 0, d);
  const newAttempts = Math.max(0, count - base);
  const first = last ?? (await d.attempts.orderBy('ts').first())?.ts ?? null;
  const week = 7 * 24 * 3600 * 1000;
  const due = newAttempts >= 300 || (newAttempts > 0 && first !== null && now - first >= week);
  return { due, since: last, newAttempts };
}

export class BackupFormatError extends Error {}

export function parseBackup(text: string): BackupFile {
  let data: Partial<BackupFile>;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new BackupFormatError('백업 파일을 읽을 수 없습니다(JSON 형식 아님)');
  }
  if (data.format !== BACKUP_FORMAT) throw new BackupFormatError('원큐합격 백업 파일이 아닙니다');
  if (data.formatVersion === 0) throw new BackupFormatError('0단계 검증 화면에서 만든 시험용 백업입니다. 학습 기록이 들어 있지 않습니다');
  if (data.formatVersion !== BACKUP_VERSION) {
    throw new BackupFormatError(`이 앱이 모르는 백업 버전(${data.formatVersion})입니다. 앱을 업데이트한 뒤 다시 시도하세요`);
  }
  for (const k of ['attempts', 'notes', 'cards', 'runs', 'orphans', 'settings'] as const) {
    if (!Array.isArray(data[k])) throw new BackupFormatError(`백업 파일이 손상됐습니다(${k} 없음)`);
  }
  return data as BackupFile;
}

export interface RestoreReport {
  added: number; // 새로 들어간 풀이
  skipped: number; // 이미 있던 풀이(같은 uid)
  notes: number;
  reconcile: ReconcileReport;
  before: Fingerprint;
  after: Fingerprint;
  /** 백업할 때의 지문과 복원 후 지문이 같은가(빈 기기에 복원했을 때 100% 일치 판정) */
  matchesBackup: boolean;
  missingPacks: { packId: string; title: string }[];
  /** 더 최신 학습 계획으로 바꾼 종목 수 */
  plansUpdated: number;
}

export async function restoreBackup(b: BackupFile, d: OneQDB = defaultDb): Promise<RestoreReport> {
  const before = await fingerprint(d);
  let added = 0;
  let skipped = 0;
  let notes = 0;
  let plansUpdated = 0;
  await safeWrite('백업 복원', () =>
    d.transaction('rw', [d.attempts, d.notes, d.cards, d.runs, d.orphans, d.settings], async () => {
      const known = new Set<string>([
        ...((await d.attempts.toArray()).map((a) => a.uid)),
        ...(await d.orphans.where('kind').equals('attempt').toArray()).map((o) => (o.data as AttemptRow).uid),
      ]);
      const newAtts: AttemptRow[] = [];
      for (const a of b.attempts) {
        if (known.has(a.uid)) {
          skipped++;
          continue;
        }
        known.add(a.uid);
        newAtts.push({ ...a });
      }
      // 매핑 대기는 그대로 매핑 대기로(이어서 reconcile이 잇는다)
      const newOrphans: OrphanRow[] = [];
      for (const o of b.orphans) {
        if (o.kind === 'attempt') {
          const uid = (o.data as AttemptRow).uid;
          if (known.has(uid)) {
            skipped++;
            continue;
          }
          known.add(uid);
          added++;
        }
        newOrphans.push({ ...o });
      }
      added += newAtts.length;
      await d.attempts.bulkAdd(newAtts);
      await d.orphans.bulkAdd(newOrphans);

      for (const n of b.notes) {
        const cur = await d.notes.get(n.qid);
        if (!cur || cur.updatedAt < n.updatedAt) {
          await d.notes.put(n);
          notes++;
        }
      }
      for (const c of b.cards) {
        const cur = await d.cards.get(c.qid);
        if (!cur) await d.cards.put(c);
      }
      for (const r of b.runs) {
        const cur = await d.runs.get(r.sessionId);
        if (!cur || cur.updatedAt < r.updatedAt) await d.runs.put(r);
      }
      for (const s of b.settings) {
        const cur = await d.settings.get(s.key);
        if (!cur) await d.settings.put(s);
        // 학습 계획은 기기 간에 맞춘다: 더 최신이면 바꿈(v0.9.2). 마지막 백업 시각·고른 종목 같은 기기별 값은 그대로
        else if (s.key.startsWith(PLAN_PREFIX) && (s.updatedAt ?? 0) > (cur.updatedAt ?? 0)) {
          await d.settings.put(s);
          plansUpdated++;
        }
      }
    }),
  );
  const rec = await reconcile(d);
  const after = await fingerprint(d);
  const installed = new Set((await d.packs.toCollection().primaryKeys()) as string[]);
  const nowUids = new Set<string>([
    ...(await d.attempts.toArray()).map((a) => a.uid),
    ...(await d.orphans.where('kind').equals('attempt').toArray()).map((o) => (o.data as AttemptRow).uid),
  ]);
  const backupUids = [...b.attempts.map((a) => a.uid), ...b.orphans.filter((o) => o.kind === 'attempt').map((o) => (o.data as AttemptRow).uid)];
  const allPresent = backupUids.every((u) => nowUids.has(u));
  const wasEmpty = before.attempts === 0 && before.notes === 0;
  return {
    added,
    skipped,
    notes,
    reconcile: rec,
    before,
    after,
    // 빈 기기에 복원: 지문이 백업 때와 같아야 100% 일치. 기록이 있던 기기: 백업의 풀이가 모두 들어왔는지
    matchesBackup: wasEmpty ? after.hash === b.fingerprint.hash : allPresent,
    missingPacks: b.packs.filter((p) => !installed.has(p.packId)).map((p) => ({ packId: p.packId, title: p.title })),
    plansUpdated,
  };
}

// ── 파일 내보내기 ──

/**
 * Android Chrome이 공유 시트로 보낼 수 있는 확장자(Chromium 허용 목록 중 앱에서 쓸 만한 것).
 * .json·.zip은 목록에 없어 NotAllowedError가 난다 → 공유용 백업은 .txt로 보낸다(0단계 실측).
 */
const SHAREABLE_EXT = ['.txt', '.text', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.html'];

export function isShareableName(name: string): boolean {
  const lower = name.toLowerCase();
  return SHAREABLE_EXT.some((ext) => lower.endsWith(ext));
}

export function canShareFiles(): boolean {
  try {
    const f = new File(['x'], 'x.txt', { type: 'text/plain' });
    return !!navigator.canShare?.({ files: [f] });
  } catch {
    return false;
  }
}

export type ExportOutcome = 'downloaded' | 'shared' | 'cancelled' | 'unsupported';

export async function exportBackup(json: string, name: string, mode: 'download' | 'share'): Promise<ExportOutcome> {
  if (mode === 'download') {
    downloadBlob(new Blob([json], { type: 'application/json' }), name);
    return 'downloaded';
  }
  const shareName = name.replace(/\.json$/, '.txt');
  if (!isShareableName(shareName)) return 'unsupported';
  const file = new File([json], shareName, { type: 'text/plain' });
  if (!navigator.canShare?.({ files: [file] })) return 'unsupported';
  try {
    // title·text를 함께 넘기면 Android 일부 받는 앱이 파일 대신 문자열만 받는다(0단계 실측) → 파일만
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    throw err;
  }
}
