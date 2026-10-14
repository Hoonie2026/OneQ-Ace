import Dexie, { type Table } from 'dexie';

/**
 * 0단계 검증용 DB. 3단계에서 학습앱 본 스키마(packs, questions, images, cards, attempts …)로
 * 교체한다. 이름을 분리해 두어 검증 데이터가 본 데이터와 섞이지 않게 한다.
 */

export type TestStatus = 'pass' | 'fail' | 'check' | 'idle';

export interface ResultRow {
  id: string; // T1 … T9
  status: TestStatus;
  detail: string;
  at: number; // epoch ms
  standalone: boolean; // 홈 화면 앱으로 실행 중에 기록했는지
}

export interface BlobRow {
  id: string; // `${packId}/${name}`
  packId: string;
  name: string;
  size: number;
  sha: string; // SHA-256 hex
  data: Blob;
}

export interface PackRow {
  packId: string;
  kind: 'dummy' | 'zip';
  title: string;
  files: number;
  bytes: number;
  savedAt: number;
  savedStandalone: boolean;
}

export interface LaunchRow {
  id?: number;
  at: number;
  standalone: boolean;
  online: boolean;
  swControlled: boolean;
}

class OneQTestDB extends Dexie {
  results!: Table<ResultRow, string>;
  blobs!: Table<BlobRow, string>;
  packs!: Table<PackRow, string>;
  launches!: Table<LaunchRow, number>;

  constructor() {
    super('oneq-stage0');
    this.version(1).stores({
      results: 'id',
      blobs: 'id, packId',
      packs: 'packId',
      launches: '++id, at',
    });
  }
}

export const db = new OneQTestDB();

/** 저장 실패 시 전역 경고를 띄우는 공통 래퍼 (개발기준서 9.3: 모든 DB 쓰기는 하나의 래퍼를 거친다) */
export const STORAGE_ERROR_EVENT = 'oneq:storage-error';

export async function safeWrite<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = describeError(err);
    window.dispatchEvent(new CustomEvent(STORAGE_ERROR_EVENT, { detail: `${label}: ${message}` }));
    throw err;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== 'Error' ? `${err.name} — ` : '';
    const inner = (err as { inner?: unknown }).inner;
    const innerMsg = inner instanceof Error ? ` (${inner.name}: ${inner.message})` : '';
    return `${name}${err.message}${innerMsg}`;
  }
  return String(err);
}

export async function saveResult(id: string, status: TestStatus, detail: string): Promise<ResultRow> {
  const row: ResultRow = { id, status, detail, at: Date.now(), standalone: isStandalone() };
  await safeWrite(`결과 기록(${id})`, () => db.results.put(row));
  return row;
}

export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}
