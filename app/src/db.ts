import Dexie, { type Table } from 'dexie';
import type { PackManifest, PackQuestion } from './pack/validate';

/**
 * 학습앱 본 DB (개발기준서 4.2). 0단계 검증 DB('oneq-stage0')와 이름을 분리했다.
 * 구조를 바꿀 때는 version()을 올리고 마이그레이션 함수와 시험을 함께 추가한다(9.3).
 */

export const DB_NAME = 'oneq';
export const STAGE0_DB_NAME = 'oneq-stage0';

export interface PackRow {
  packId: string;
  packVersion: number;
  manifest: PackManifest;
  importedAt: number;
  bytes: number; // 이미지 합계
}

/** 팩의 문항 메타데이터 그대로 + 검색용 packId */
export interface QuestionRow extends PackQuestion {
  packId: string;
}

export type ImageKind = 'full';
export interface ImageRow {
  qid: string;
  kind: ImageKind;
  packId: string;
  data: Blob;
}

/** 4단계(ts-fsrs)에서 채운다. 원장(attempts)에서 다시 계산할 수 있는 파생값 */
export interface CardRow {
  qid: string;
  due: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview?: number;
}

/** round·subject = 회독(ADR 003), wrong = 오답 다시 풀기, today = 오늘 학습(엔진 세션), mock = 모의고사(5단계) */
export type AttemptMode = 'round' | 'subject' | 'wrong' | 'today' | 'mock';

/** 모든 풀이 이력(원장). chosen 0 = 모름 */
export interface AttemptRow {
  id?: number;
  uid: string; // 기기 간·백업 간 같은 기록을 판별하는 키
  qid: string;
  contentHash: string; // 재전처리·팩 갱신 시 기록을 다시 잇는 키
  ts: number;
  chosen: number;
  correct: boolean;
  /** 예전 "자신 없이 맞힘"(v0.7 답하기 전 웹검색·헷갈림). v0.9.2부터 쓰지도 읽지도 않음 — 옛 기록·백업 호환으로만 남김 */
  unsure?: boolean;
  /** [쉬움]으로 답함(v0.9.2): 보기 없이 정답 처리. chosen에는 정답 번호를 넣는다 */
  easy?: boolean;
  elapsedMs: number;
  mode: AttemptMode;
  sessionId: string;
}

export interface NoteRow {
  qid: string;
  contentHash: string;
  text: string;
  updatedAt: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
  /** 학습 계획(plan:종목)처럼 기기 간에 맞출 설정만 — 복원 때 더 최신 것이 이긴다(v0.9.2) */
  updatedAt?: number;
}

/** 풀이 묶음(회차 전체·과목·오답 다시 풀기). 이어 풀기 위치를 기억한다 */
export interface RunRow {
  sessionId: string;
  packId: string;
  mode: AttemptMode;
  title: string;
  qids: string[];
  index: number; // 지금 보고 있는 문항 위치
  answered: Record<string, string>; // qid → attempt uid
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  /** 여러 회차에 걸친 묶음(오늘 학습·모의고사)의 자격종목. 이때 packId는 `${종목}-@${mode}` */
  certCode?: string;
  /** 모의고사 제한 시간(초), 멈춘 시각, 멈춘 시간 합(ms) — ✕로 나가면 시간이 멈춘다 */
  limitSec?: number;
  pausedAt?: number | null;
  pausedMs?: number;
  /** 과목을 골라 시작한 학습 묶음의 과목("이 과목 계속") */
  subjectKey?: string;
  /** 오늘 학습 묶음 끝의 "틀린 문항 한 번 더" 묶음(여기서 또 틀려도 다시 만들지 않음) */
  relearn?: boolean;
}

/** 문항에 다시 잇지 못한 기록. 조용히 지우지 않고 여기 보관한다(4.3) */
export interface OrphanRow {
  id?: number;
  kind: 'attempt' | 'note' | 'card';
  qid: string;
  contentHash: string;
  packId: string;
  reason: 'pack-missing' | 'pack-removed' | 'no-match';
  data: AttemptRow | NoteRow | CardRow;
  at: number;
}

export class OneQDB extends Dexie {
  packs!: Table<PackRow, string>;
  questions!: Table<QuestionRow, string>;
  images!: Table<ImageRow, [string, ImageKind]>;
  cards!: Table<CardRow, string>;
  attempts!: Table<AttemptRow, number>;
  notes!: Table<NoteRow, string>;
  settings!: Table<SettingRow, string>;
  runs!: Table<RunRow, string>;
  orphans!: Table<OrphanRow, number>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(1).stores({
      packs: 'packId',
      questions: 'qid, packId, contentHash',
      images: '[qid+kind], packId',
      cards: 'qid, due',
      attempts: '++id, &uid, qid, ts, sessionId, contentHash',
      notes: 'qid, contentHash',
      settings: 'key',
      runs: 'sessionId, packId, updatedAt',
      orphans: '++id, kind, packId, contentHash',
    });
  }
}

export const db = new OneQDB();

/** 저장 실패 시 전역 경고를 띄우는 공통 래퍼 (9.3: 모든 DB 쓰기는 하나의 래퍼를 거친다) */
export const STORAGE_ERROR_EVENT = 'oneq:storage-error';

export async function safeWrite<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const quota = isQuotaError(err);
    const message = quota ? '저장공간이 부족합니다. 사용하지 않는 문제팩을 지우거나 기기 공간을 확보하세요' : describeError(err);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(STORAGE_ERROR_EVENT, { detail: `${label}: ${message}` }));
    }
    throw err;
  }
}

export function isQuotaError(err: unknown): boolean {
  const names = [err, (err as { inner?: unknown })?.inner].map((e) => (e as { name?: string })?.name);
  return names.some((n) => n === 'QuotaExceededError');
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

// ── 설정 ──
export const SETTING = {
  lastBackupAt: 'lastBackupAt',
  attemptsAtLastBackup: 'attemptsAtLastBackup',
  certCode: 'certCode', // 홈에서 고른 자격종목
} as const;

export async function getSetting<T>(key: string, fallback: T, d: OneQDB = db): Promise<T> {
  const row = await d.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setSetting(key: string, value: unknown, d: OneQDB = db): Promise<void> {
  await safeWrite('설정 저장', () => d.settings.put({ key, value }));
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

export function newId(): string {
  return crypto.randomUUID();
}
