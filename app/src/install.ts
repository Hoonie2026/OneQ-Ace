/**
 * 앱 설치 돕기(v0.10.1 — 실기기 Y6·추가 검토: "설치가 복잡하면 시작부터 안 한다").
 * - Chrome·Edge·삼성 인터넷(안드로이드·PC)은 beforeinstallprompt를 받아 두었다가 [앱 설치] 단추 한 번으로 설치 창을 띄운다
 * - 카카오톡 안 브라우저는 카카오톡이 제공하는 주소(kakaotalk://web/openExternal)로 기본 브라우저에서 다시 연다
 * - 그 밖의 앱 안 브라우저(네이버 앱 등): 안드로이드는 Chrome 열기 주소(intent://), 아이폰은 Safari로 여는 방법 안내
 * 이벤트는 페이지가 뜨자마자 오므로 main.tsx에서 이 파일을 먼저 가져와 듣기 시작한다
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const INSTALLED_KEY = 'oneq-installed-at';
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 브라우저 기본 띠 대신 앱의 안내 카드에서 단추로
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    try {
      localStorage.setItem(INSTALLED_KEY, String(Date.now()));
    } catch {
      /* 기록 못 해도 이번 화면에서는 안내 */
    }
    deferred = null;
    notify();
  });
}

export function canPromptInstall(): boolean {
  return !!deferred;
}

export function justInstalled(): boolean {
  return installed;
}

export function onInstallChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 설치 창을 띄운다. 설치하면 true */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  await e.prompt();
  const r = await e.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  notify();
  return r.outcome === 'accepted';
}

/** 앱 안 브라우저에서 바깥 브라우저로 여는 주소 */
export function externalOpenUrl(inApp: 'kakao' | 'naver' | 'other', os: string, url: string): string | null {
  if (inApp === 'kakao') return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  if (os === 'android') {
    const u = new URL(url);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;end`;
  }
  return null; // 아이폰의 다른 앱 안 브라우저는 주소로 열 수 없음 → 안내
}

/** 이 브라우저에서 설치를 누른 적이 있으면 그 시각(안드로이드는 앱 아이콘이 생기기까지 1~2분 — 실기기 Z4b) */
export function installedAt(): number | null {
  try {
    const v = Number(localStorage.getItem(INSTALLED_KEY) ?? 0);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * 이 기기에 앱이 실제로 설치됐는지(안드로이드 Chrome: manifest의 related_applications "webapp" + getInstalledRelatedApps).
 * 지원하지 않는 브라우저는 null
 */
export async function appInstalledOnDevice(): Promise<boolean | null> {
  const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
  if (!nav.getInstalledRelatedApps) return null;
  try {
    return (await nav.getInstalledRelatedApps()).length > 0;
  } catch {
    return null;
  }
}

export function forgetInstalled(): void {
  try {
    localStorage.removeItem(INSTALLED_KEY);
  } catch {
    /* 무시 */
  }
}
