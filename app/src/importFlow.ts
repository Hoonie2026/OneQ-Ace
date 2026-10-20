/**
 * 문제팩 가져오기 진행·지연·중단 안내(v0.10.7 — 태블릿 실사용 의견).
 *
 * 가져오기는 두 구간이다.
 * 1. 파일 선택기 구간: 구글 드라이브 등 클라우드 파일을 고르면 기기(OS)가 파일을 모두 내려받은 뒤에야 앱에 넘겨준다.
 *    이 동안 앱은 아무것도 할 수 없고, 파일이 많으면 브라우저가 메모리를 비우려고 앱을 다시 시작하기도 한다
 *    (사용자에게는 "아무 안내 없이 홈 화면으로 돌아감"으로 보임).
 *    → 선택기를 열 때 표시를 남겨 두고, 앱이 다시 시작됐는데 표시가 남아 있으면 안내한다.
 * 2. 앱 처리 구간: 파일마다 읽기 → 검사 → 저장. → 진행 창(몇 번째/전체, 막대), 한 파일이 오래 걸리면 안내.
 */

const PICK_KEY = 'oneq-import-pick';

/** 한 파일이 이보다 오래 걸리면 "오래 걸리고 있습니다" 안내 */
export const SLOW_FILE_MS = 20_000;
/** 선택기에서 파일을 받기까지 이보다 오래 걸렸으면(클라우드에서 내려받음) 끝난 뒤 요령을 덧붙인다 */
export const SLOW_PICK_MS = 15_000;
/** 앱이 다시 시작됐을 때 이 시간 안에 연 선택기만 "중단됨"으로 본다 */
const PICK_STALE_MS = 15 * 60_000;
/** 한 번에 이보다 많이 고르면 진행 창에 "몇 분 걸릴 수 있음"을 미리 알린다 */
export const MANY_FILES = 15;

const store = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** 선택기를 열 때 */
export function markPickStart(now = Date.now()): void {
  try {
    store()?.setItem(PICK_KEY, String(now));
  } catch {
    /* 저장 못 해도 가져오기는 된다 */
  }
}

/** 선택기를 닫을 때(파일을 받았거나 취소) — 연 지 몇 ms 지났는지 */
export function clearPick(now = Date.now()): number | null {
  try {
    const s = store();
    const v = s?.getItem(PICK_KEY);
    s?.removeItem(PICK_KEY);
    return v ? Math.max(0, now - Number(v)) : null;
  } catch {
    return null;
  }
}

/** 앱 시작 때: 선택기를 연 채로 앱이 다시 시작됐는가(파일을 받기 전에 중단됨) */
export function interruptedPick(now = Date.now()): boolean {
  const age = clearPick(now);
  return age !== null && age < PICK_STALE_MS;
}

export type ImportPhase = 'read' | 'check' | 'save';

export interface ImportProgress {
  total: number;
  /** 끝난 파일 수 */
  done: number;
  name: string;
  phase: ImportPhase;
  startedAt: number;
  fileStartedAt: number;
  /** 사용자가 [그만 가져오기]를 눌렀음 — 지금 파일까지만 */
  stopping: boolean;
}

export const PHASE_TEXT: Record<ImportPhase, string> = {
  read: '파일 읽는 중',
  check: '검사하는 중',
  save: '저장하는 중',
};

/** 진행 막대 비율(0~1). 지금 파일은 단계만큼 조금 채운다 */
export function progressRatio(p: Pick<ImportProgress, 'total' | 'done' | 'phase'>): number {
  if (!p.total) return 0;
  const part = p.phase === 'read' ? 0.1 : p.phase === 'check' ? 0.4 : 0.7;
  return Math.min(1, (p.done + (p.done < p.total ? part : 0)) / p.total);
}

export const isSlow = (p: Pick<ImportProgress, 'fileStartedAt'>, now = Date.now()) => now - p.fileStartedAt >= SLOW_FILE_MS;

export const SLOW_MESSAGE =
  '가져오는 데 시간이 오래 걸리고 있습니다. 계속 기다려도 되고, 그만 가져온 뒤 한 번에 가져오는 파일 수를 줄여서(10개 이하) 다시 시도해 주세요. 이미 가져온 팩은 남아 있고, 같은 파일을 다시 골라도 건너뜁니다.';

export const INTERRUPTED_MESSAGE =
  '지난번 문제팩 가져오기가 끝나지 않고 앱이 다시 시작된 것 같습니다.\n\n' +
  '구글 드라이브 같은 클라우드에서 여러 파일을 한꺼번에 고르면, 기기가 파일을 모두 내려받는 동안 앱이 멈추거나 다시 시작될 수 있습니다.\n\n' +
  '• 한 번에 10개 이하로 나눠서 가져오거나\n' +
  '• 먼저 파일을 기기(다운로드 폴더)에 내려받은 뒤 가져오면 빠르고 안정적입니다.\n\n' +
  '이미 가져온 팩은 남아 있습니다. 설정 → 문제팩에서 확인하세요.';

export const SLOW_PICK_TIP = '파일을 받는 데 시간이 걸렸습니다. 클라우드 파일은 기기에 먼저 내려받은 뒤 가져오면 빠릅니다.';
