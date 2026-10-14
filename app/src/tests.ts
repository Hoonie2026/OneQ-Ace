import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { db, describeError, isStandalone, safeWrite, saveResult, type BlobRow, type ResultRow } from './db';
import { formatBytes, randomBytes, sha256Hex, yyyymmdd, deviceSummary, downloadBlob } from './util';

export const DUMMY_PACK_ID = 'dummy-30mb';
const DUMMY_FILES = 100; // 문항 이미지 100장 가정
const DUMMY_FILE_SIZE = 300 * 1024; // 장당 300KB → 합계 약 30MB
const BATCH = 10; // 트랜잭션당 장 수 (iOS에서 한 번에 큰 트랜잭션을 피함)

export const PACK_FORMAT = 'oneq-pack';
export const BACKUP_FORMAT = 'oneq-backup';

type Progress = (msg: string) => void;

// ── T3 영구 저장 ─────────────────────────────────────────────
export async function testPersist(): Promise<ResultRow> {
  if (!navigator.storage?.persist) {
    return saveResult('T3', 'fail', '이 브라우저는 영구 저장 요청(StorageManager.persist)을 지원하지 않음');
  }
  const before = await navigator.storage.persisted();
  const granted = before || (await navigator.storage.persist());
  return saveResult(
    'T3',
    granted ? 'pass' : 'check',
    granted
      ? `영구 저장 허용됨${before ? ' (이미 허용 상태)' : ''}`
      : '영구 저장 거부됨 — 홈 화면에 설치한 앱에서 다시 시도하세요. 거부돼도 앱은 동작하지만 저장공간 부족 시 지워질 수 있음',
  );
}

// ── T4 사용량 ───────────────────────────────────────────────
export interface StorageInfo {
  usage?: number;
  quota?: number;
  persisted?: boolean;
}

export async function readStorageInfo(): Promise<StorageInfo> {
  const info: StorageInfo = {};
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      info.usage = e.usage;
      info.quota = e.quota;
    }
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
  } catch {
    /* 표시만 생략 */
  }
  return info;
}

export async function testEstimate(): Promise<ResultRow> {
  const info = await readStorageInfo();
  if (info.quota === undefined) {
    return saveResult('T4', 'fail', '사용량 조회(StorageManager.estimate)를 지원하지 않음');
  }
  const pct = info.usage !== undefined && info.quota ? ((info.usage / info.quota) * 100).toFixed(2) : '?';
  return saveResult('T4', 'pass', `사용 ${formatBytes(info.usage)} / 한도 ${formatBytes(info.quota)} (${pct}%)`);
}

// ── T5 30MB 더미 팩 저장·읽기 ────────────────────────────────
export async function testDummyPack(onProgress: Progress): Promise<ResultRow> {
  const t0 = performance.now();
  try {
    await safeWrite('기존 더미 팩 삭제', () =>
      db.transaction('rw', db.blobs, db.packs, async () => {
        await db.blobs.where('packId').equals(DUMMY_PACK_ID).delete();
        await db.packs.delete(DUMMY_PACK_ID);
      }),
    );

    let written = 0;
    for (let start = 0; start < DUMMY_FILES; start += BATCH) {
      const rows: BlobRow[] = [];
      for (let i = start; i < Math.min(start + BATCH, DUMMY_FILES); i++) {
        const bytes = randomBytes(DUMMY_FILE_SIZE);
        const name = `q${String(i + 1).padStart(3, '0')}.webp`;
        rows.push({
          id: `${DUMMY_PACK_ID}/${name}`,
          packId: DUMMY_PACK_ID,
          name,
          size: bytes.byteLength,
          sha: await sha256Hex(bytes),
          data: new Blob([bytes as BlobPart], { type: 'image/webp' }),
        });
      }
      await safeWrite('더미 팩 저장', () => db.blobs.bulkPut(rows));
      written += rows.reduce((s, r) => s + r.size, 0);
      onProgress(`저장 중 ${formatBytes(written)} / ${formatBytes(DUMMY_FILES * DUMMY_FILE_SIZE)}`);
    }
    await safeWrite('더미 팩 목록 저장', () =>
      db.packs.put({
        packId: DUMMY_PACK_ID,
        kind: 'dummy',
        title: '30MB 더미 팩',
        files: DUMMY_FILES,
        bytes: written,
        savedAt: Date.now(),
        savedStandalone: isStandalone(),
      }),
    );
    const t1 = performance.now();

    onProgress('다시 읽어 무결성 확인 중…');
    const check = await verifyPack(DUMMY_PACK_ID, true);
    const t2 = performance.now();
    if (!check.ok) return saveResult('T5', 'fail', `저장은 됐으나 읽기 검증 실패: ${check.detail}`);
    return saveResult(
      'T5',
      'pass',
      `${DUMMY_FILES}장 · ${formatBytes(written)} 저장 ${((t1 - t0) / 1000).toFixed(1)}초, 전수 해시 검증 ${((t2 - t1) / 1000).toFixed(1)}초`,
    );
  } catch (err) {
    return saveResult('T5', 'fail', `저장 실패: ${describeError(err)}`);
  }
}

/** 팩의 파일 수·용량(빠른 확인) 또는 전체 SHA-256(전수 확인)을 검증한다 */
export async function verifyPack(packId: string, full: boolean): Promise<{ ok: boolean; detail: string }> {
  const pack = await db.packs.get(packId);
  if (!pack) return { ok: false, detail: '팩 목록에 없음' };
  const rows = await db.blobs.where('packId').equals(packId).toArray();
  const bytes = rows.reduce((s, r) => s + r.data.size, 0);
  if (rows.length !== pack.files) return { ok: false, detail: `파일 ${rows.length}/${pack.files}개` };
  if (bytes !== pack.bytes) return { ok: false, detail: `용량 ${formatBytes(bytes)} ≠ ${formatBytes(pack.bytes)}` };
  if (full) {
    for (const r of rows) {
      const sha = await sha256Hex(await r.data.arrayBuffer());
      if (sha !== r.sha) return { ok: false, detail: `${r.name} 해시 불일치` };
    }
  }
  return { ok: true, detail: `${rows.length}개 · ${formatBytes(bytes)}` };
}

// ── T1·T2·T6 실행 시 자동 확인 ─────────────────────────────────
export async function onLaunch(swControlled: boolean): Promise<void> {
  const standalone = isStandalone();
  const online = navigator.onLine;
  const prev = await db.launches.orderBy('at').last();
  await safeWrite('실행 기록', () => db.launches.add({ at: Date.now(), standalone, online, swControlled }));

  if (standalone) await saveResult('T1', 'pass', '홈 화면 앱(standalone)으로 실행됨');

  if (!online && swControlled) {
    await saveResult('T2', 'pass', '오프라인 상태에서 앱이 열림 (서비스워커 캐시)');
  }

  // T6: 이전 실행에서 저장한 더미 팩이 이번 실행에도 그대로인지
  const pack = await db.packs.get(DUMMY_PACK_ID);
  // 실행 직후 시점에 이미 팩이 있다면 이전 실행에서 저장된 것이다
  if (pack && prev) {
    const check = await verifyPack(DUMMY_PACK_ID, false);
    const sameMode = pack.savedStandalone === standalone;
    if (check.ok) {
      await saveResult(
        'T6',
        sameMode ? 'pass' : 'check',
        `재실행 후 유지됨: ${check.detail} (저장 ${new Date(pack.savedAt).toLocaleString('ko-KR')})` +
          (sameMode ? '' : ' — 저장 때와 실행 방식(브라우저/홈 화면 앱)이 다름'),
      );
    } else {
      await saveResult('T6', 'fail', `재실행 후 데이터 손상·삭제: ${check.detail}`);
    }
  } else if (!pack) {
    const existing = await db.results.get('T5');
    if (existing?.status === 'pass') {
      await saveResult(
        'T6',
        standalone === existing.standalone ? 'fail' : 'check',
        standalone === existing.standalone
          ? 'T5에서 저장한 30MB 팩이 재실행 후 사라짐'
          : '팩이 보이지 않음 — 저장 때와 실행 방식(브라우저/홈 화면 앱)이 달라 저장소가 분리된 것일 수 있음',
      );
    }
  }
}

// ── T7 zip 가져오기 ─────────────────────────────────────────
interface PackManifest {
  format: string;
  formatVersion: number;
  packId: string;
  title: string;
  source?: string;
  preparedBy?: string;
  packVersion?: number;
}

/** 휴대폰만으로 가져오기를 시험할 수 있게 샘플 팩(zip)을 만든다 */
export async function buildSampleZip(): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    formatVersion: 0,
    packId: 'sample-stage0',
    title: '0단계 샘플 팩 (가짜 문항 5개)',
    source: 'test',
    preparedBy: 'OneQ-Ace 0단계 검증 화면',
    packVersion: 1,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  for (let i = 1; i <= 5; i++) {
    files[`img/q${String(i).padStart(3, '0')}.png`] = await drawSampleImage(i);
  }
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

async function drawSampleImage(n: number): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = 1080;
  c.height = 520;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#111827';
  g.font = 'bold 44px sans-serif';
  g.fillText(`${n}. 샘플 문항입니다. 다음 중 옳은 것은?`, 48, 90);
  g.font = '38px sans-serif';
  ['① 첫 번째 보기', '② 두 번째 보기', '③ 세 번째 보기', '④ 네 번째 보기'].forEach((t, i) =>
    g.fillText(t, 72, 190 + i * 80),
  );
  g.strokeStyle = '#f2b830';
  g.lineWidth = 8;
  g.strokeRect(4, 4, c.width - 8, c.height - 8);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 실패'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportSampleZip(): Promise<string> {
  const blob = await buildSampleZip();
  const name = 'oneq-sample-stage0.zip';
  const shared = await shareOrDownload(blob, name, 'application/zip', 'download');
  return `${name} (${formatBytes(blob.size)}) ${shared}`;
}

export async function testImportZip(file: File): Promise<{ row: ResultRow; previewPackId?: string }> {
  try {
    const t0 = performance.now();
    const buf = new Uint8Array(await file.arrayBuffer());
    const entries = unzipSync(buf);
    const manifestBytes = entries['manifest.json'];
    if (!manifestBytes) {
      return { row: await saveResult('T7', 'fail', `${file.name}: manifest.json이 없어 문제팩이 아님`) };
    }
    const manifest = JSON.parse(strFromU8(manifestBytes)) as PackManifest;
    if (manifest.format !== PACK_FORMAT || !manifest.packId) {
      return { row: await saveResult('T7', 'fail', `${file.name}: format이 '${PACK_FORMAT}'가 아님`) };
    }
    const rows: BlobRow[] = [];
    for (const [name, bytes] of Object.entries(entries)) {
      if (name === 'manifest.json' || name.endsWith('/')) continue;
      const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';
      rows.push({
        id: `${manifest.packId}/${name}`,
        packId: manifest.packId,
        name,
        size: bytes.byteLength,
        sha: await sha256Hex(bytes),
        data: new Blob([bytes as BlobPart], { type }),
      });
    }
    const bytes = rows.reduce((s, r) => s + r.size, 0);
    await safeWrite('팩 가져오기', () =>
      db.transaction('rw', db.blobs, db.packs, async () => {
        await db.blobs.where('packId').equals(manifest.packId).delete();
        await db.blobs.bulkPut(rows);
        await db.packs.put({
          packId: manifest.packId,
          kind: 'zip',
          title: manifest.title,
          files: rows.length,
          bytes,
          savedAt: Date.now(),
          savedStandalone: isStandalone(),
        });
      }),
    );
    const check = await verifyPack(manifest.packId, true);
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    const row = await saveResult(
      'T7',
      check.ok ? 'check' : 'fail',
      check.ok
        ? `${file.name} → ${rows.length}개 파일 · ${formatBytes(bytes)} 저장 (${sec}초). 아래 미리보기 이미지가 보이면 통과로 표시하세요`
        : `가져오기 후 검증 실패: ${check.detail}`,
    );
    return { row, previewPackId: check.ok ? manifest.packId : undefined };
  } catch (err) {
    return { row: await saveResult('T7', 'fail', `${file.name}: ${describeError(err)}`) };
  }
}

// ── T8 백업 내보내기 / T9 복원 ───────────────────────────────
export interface BackupFile {
  format: string;
  formatVersion: number;
  createdAt: string;
  device: string;
  results: ResultRow[];
  launches: number;
  packs: { packId: string; files: number; bytes: number }[];
}

async function buildBackup(): Promise<{ blob: Blob; name: string; data: BackupFile }> {
  const data: BackupFile = {
    format: BACKUP_FORMAT,
    formatVersion: 0,
    createdAt: new Date().toISOString(),
    device: deviceSummary(),
    results: await db.results.toArray(),
    launches: await db.launches.count(),
    packs: (await db.packs.toArray()).map((p) => ({ packId: p.packId, files: p.files, bytes: p.bytes })),
  };
  const name = `oneq-backup-${yyyymmdd()}.json`;
  return { blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name, data };
}

/**
 * Android Chrome이 공유 시트로 보낼 수 있는 확장자(Chromium share_service_impl.cc의 허용 목록 중 앱에서 쓸 만한 것).
 * .json·.zip은 목록에 없어 NotAllowedError(Permission denied)가 난다 → 공유용 백업은 .txt로 보낸다.
 */
const SHAREABLE_EXT = ['.txt', '.text', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.html'];

export function isShareableName(name: string): boolean {
  const lower = name.toLowerCase();
  return SHAREABLE_EXT.some((ext) => lower.endsWith(ext));
}

/** 공유 시트 또는 다운로드로 파일을 내보낸다. 결과를 문장으로 돌려준다 */
export async function shareOrDownload(
  blob: Blob,
  name: string,
  type: string,
  mode: 'share' | 'download',
): Promise<string> {
  if (mode === 'share') {
    if (!isShareableName(name)) return `— 공유 시트로 보낼 수 없는 확장자(${name})`;
    const file = new File([blob], name, { type });
    if (!navigator.canShare?.({ files: [file] })) return '— 이 브라우저는 파일 공유 시트를 지원하지 않음';
    try {
      await navigator.share({ files: [file], title: name });
      return '— 공유 시트에서 전달 완료';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return '— 공유 시트를 닫음(취소)';
      throw err;
    }
  }
  downloadBlob(blob, name);
  return '— 다운로드 시작';
}

export async function testBackupExport(mode: 'share' | 'download'): Promise<ResultRow> {
  const id = mode === 'share' ? 'T8a' : 'T8b';
  try {
    const { blob, name } = await buildBackup();
    // 공유 시트: 내용은 같은 JSON, 확장자만 .txt (Android Chrome 허용 목록 대응). 복원은 .json·.txt 모두 받는다
    const outName = mode === 'share' ? name.replace(/\.json$/, '.txt') : name;
    const outType = mode === 'share' ? 'text/plain' : 'application/json';
    const msg = await shareOrDownload(
      new Blob([blob], { type: outType }),
      outName,
      outType,
      mode,
    );
    const label = mode === 'share' ? '공유 시트' : '다운로드';
    const unsupported = msg.includes('지원하지 않음') || msg.includes('보낼 수 없는');
    return saveResult(
      id,
      unsupported ? 'fail' : 'check',
      `${label}: ${outName} (${formatBytes(blob.size)}) ${msg}` +
        (unsupported ? '' : '. 파일 앱/드라이브/다운로드 폴더에 실제로 저장됐으면 통과로 표시하세요'),
    );
  } catch (err) {
    return saveResult(id, 'fail', describeError(err));
  }
}

export async function testBackupRestore(file: File): Promise<ResultRow> {
  try {
    const data = JSON.parse(await file.text()) as Partial<BackupFile>;
    if (data.format !== BACKUP_FORMAT || !Array.isArray(data.results)) {
      return saveResult('T9', 'fail', `${file.name}: 원큐합격 백업 파일이 아님`);
    }
    const current = await db.results.toArray();
    const backupIds = new Set(data.results.map((r) => r.id));
    const matched = current.filter((r) => backupIds.has(r.id)).length;
    return saveResult(
      'T9',
      'pass',
      `${file.name} 읽기 성공: ${data.createdAt ? new Date(data.createdAt).toLocaleString('ko-KR') : '?'} 생성, 결과 ${data.results.length}건(현재 기록과 ${matched}건 일치), 실행 ${data.launches}회`,
    );
  } catch (err) {
    return saveResult('T9', 'fail', `${file.name}: ${describeError(err)}`);
  }
}

// ── 결과 요약(대화창에 붙여 넣기용) ────────────────────────────
export const TEST_LABELS: Record<string, string> = {
  T1: '홈 화면 설치·실행',
  T2: '오프라인(비행기 모드) 실행',
  T3: '영구 저장 요청',
  T4: '저장공간 사용량 표시',
  T5: '30MB 더미 팩 저장·읽기',
  T6: '앱 재실행 후 데이터 유지',
  T7: 'zip 문제팩 가져오기·이미지 표시',
  T8a: '백업 내보내기 — 공유 시트',
  T8b: '백업 내보내기 — 다운로드',
  T9: '백업 파일 읽기(복원)',
};

const STATUS_TEXT = { pass: '통과', fail: '실패', check: '확인 필요', idle: '미실행' } as const;

export async function buildReport(): Promise<string> {
  const info = await readStorageInfo();
  const results = new Map((await db.results.toArray()).map((r) => [r.id, r]));
  const launches = await db.launches.count();
  const lines = [
    `[원큐합격 0단계 결과] ${new Date().toLocaleString('ko-KR')}`,
    `기기: ${deviceSummary()}`,
    `실행 방식: ${isStandalone() ? '홈 화면 앱' : '브라우저 탭'} · 누적 실행 ${launches}회`,
    `저장: 사용 ${formatBytes(info.usage)} / 한도 ${formatBytes(info.quota)} · 영구 저장 ${info.persisted ? '허용' : '미허용'}`,
    '',
  ];
  for (const [id, label] of Object.entries(TEST_LABELS)) {
    const r = results.get(id);
    lines.push(`${id} ${label}: ${r ? STATUS_TEXT[r.status] : '미실행'}${r ? ` — ${r.detail}` : ''}`);
  }
  lines.push('', `UA: ${navigator.userAgent}`);
  return lines.join('\n');
}
