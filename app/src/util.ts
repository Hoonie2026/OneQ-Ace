export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '알 수 없음';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function yyyymmdd(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function deviceSummary(): string {
  const ua = navigator.userAgent;
  let os = '기타';
  const android = ua.match(/Android\s([\d.]+)/);
  const ios = ua.match(/OS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/);
  if (android) os = `Android ${android[1]}`;
  else if (ios) os = `iOS ${ios[1]}.${ios[2]}${ios[3] ? '.' + ios[3] : ''}`;
  else if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) os = 'iPadOS (데스크톱 모드)';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';

  let browser = '기타';
  const chrome = ua.match(/(?:Chrome|CriOS)\/(\d+)/);
  const samsung = ua.match(/SamsungBrowser\/(\d+)/);
  const safari = ua.match(/Version\/(\d+[.\d]*).*Safari/);
  if (samsung) browser = `삼성 인터넷 ${samsung[1]}`;
  else if (chrome) browser = `Chrome ${chrome[1]}`;
  else if (safari) browser = `Safari ${safari[1]}`;
  return `${os} · ${browser}`;
}

export interface DeviceEnv {
  os: 'android' | 'ios' | 'windows' | 'mac' | 'other';
  /** 휴대폰·태블릿 구분(아이패드 데스크톱 모드 포함) */
  kind: 'phone' | 'tablet' | 'pc';
  browser: string;
  standalone: boolean;
  /** 앱 안 브라우저(v0.10.1): 카카오톡·네이버 앱 등에서 링크를 누르면 그 앱 안에서 열린다 — 설치가 안 되고 기록도 따로 */
  inApp: 'kakao' | 'naver' | 'other' | null;
}

/** 홈 화면·설치 앱으로 열렸는지(db.isStandalone과 같음 — util은 db를 가져오지 않음) */
function standaloneNow(): boolean {
  if (typeof window === 'undefined') return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function deviceEnv(ua = navigator.userAgent, touch = navigator.maxTouchPoints ?? 0, standalone = standaloneNow()): DeviceEnv {
  const ipadDesktop = /Macintosh/.test(ua) && touch > 1;
  const os: DeviceEnv['os'] = /Android/.test(ua) ? 'android' : /iPhone|iPad|iPod/.test(ua) || ipadDesktop ? 'ios' : /Windows/.test(ua) ? 'windows' : /Mac OS X/.test(ua) ? 'mac' : 'other';
  const kind: DeviceEnv['kind'] = /iPad/.test(ua) || ipadDesktop || (os === 'android' && !/Mobile/.test(ua)) ? 'tablet' : os === 'android' || os === 'ios' ? 'phone' : 'pc';
  const inApp: DeviceEnv['inApp'] = /KAKAOTALK/i.test(ua)
    ? 'kakao'
    : /NAVER\(inapp|NAVER\//.test(ua)
      ? 'naver'
      : /Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|BAND\/|; wv\)/.test(ua) || (os === 'ios' && !/Safari\//.test(ua) && !standalone)
        ? 'other'
        : null;
  const browser = /SamsungBrowser/.test(ua)
    ? '삼성 인터넷'
    : /Edg(A|iOS)?\//.test(ua)
      ? 'Edge'
      : /Whale/.test(ua)
        ? '웨일'
        : /CriOS|Chrome/.test(ua)
          ? 'Chrome'
          : /Firefox|FxiOS/.test(ua)
            ? 'Firefox'
            : /Safari/.test(ua)
              ? 'Safari'
              : '브라우저';
  return { os, kind, browser, standalone, inApp };
}

/** 이 휴대폰 · 이 태블릿 · 이 아이폰 · 이 아이패드 · 이 PC */
export function deviceNoun(env: DeviceEnv): string {
  return env.kind === 'pc' ? '이 PC' : env.os === 'ios' ? (env.kind === 'tablet' ? '이 아이패드' : '이 아이폰') : env.kind === 'tablet' ? '이 태블릿' : '이 휴대폰';
}

/**
 * 학습 기록·문제팩이 어디에 저장되고 언제 지워지는지(v0.9.2 — 실사용 의견: 영구 저장이 아이폰에서는? 사용자가 저장 위치를 알아야).
 * v0.10.1(실기기 Y1·Y2): "사이트 데이터·전용 저장소" 같은 말은 처음 쓰는 사람이 모른다 → "○○ 안에 저장"처럼 짧게.
 * 근거: Android Chrome 설치 앱은 브라우저 사이트 데이터를 같이 씀. iOS 홈 화면 앱은 Safari와 저장소가 따로이고(WebKit 버그 181849)
 * Safari의 7일 미사용 삭제 규칙을 받지 않음(WebKit 해명). "인터넷 사용 기록 삭제"는 영구 저장이어도 지운다
 */
export function storagePlace(env: DeviceEnv): { where: string; risks: string[]; warn?: string } {
  const dev = deviceNoun(env);
  const reset = env.kind === 'pc' ? 'PC를 바꾸거나 윈도우를 다시 설치할 때' : '휴대폰을 초기화하거나 바꿀 때';
  if (env.os === 'ios' && env.standalone)
    return {
      where: `${dev}의 원큐합격 앱 안(Safari와 별도)`,
      risks: ['홈 화면에서 원큐합격 아이콘을 삭제할 때', 'Safari의 방문 기록·웹 사이트 데이터를 지울 때(함께 지워질 수 있음)', reset],
    };
  if (env.os === 'ios')
    return {
      where: `${dev}의 ${env.browser} 안(홈 화면 앱과 별도)`,
      risks: [`${env.browser}의 방문 기록·웹 사이트 데이터를 지울 때`, '7일 넘게 이 화면에서 쓰지 않을 때', reset],
      warn: '지금 브라우저 화면에서 열었습니다. 아이폰·아이패드는 홈 화면에 추가한 앱과 기록이 따로 저장됩니다. 홈 화면의 원큐합격 아이콘으로 학습하세요.',
    };
  const where = env.kind === 'pc' ? `${dev}의 ${env.browser} 안(지금 쓰는 사용자 프로필)` : `${dev}의 ${env.browser} 앱 안`;
  const risks = [`${env.browser}에서 인터넷 사용 기록 삭제 → 「쿠키 및 사이트 데이터」를 지울 때(영구 저장이어도 지워짐)`];
  if (env.kind === 'pc') risks.push('다른 브라우저·다른 프로필·시크릿 창에서는 보이지 않음');
  else risks.push(`${env.browser} 앱의 데이터를 지울 때(원큐합격 아이콘만 지우면 그대로)`);
  risks.push(reset);
  return { where, risks };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

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

/**
 * 손가락으로 확대한 화면을 원래 크기로(v0.8.1 실기기 의견): 홈을 확대한 채 학습 화면으로 가면 확대가 그대로 남고,
 * 풀이 화면은 문제 그림 상자가 자체 확대(핀치)를 쓰느라 페이지 축소가 잘 안 돼 아래 보기·다음 단추가 화면 밖에 남았다.
 * viewport에 잠시 maximum-scale=1을 넣으면 브라우저가 배율을 1로 되돌린다(곧바로 원래 값으로 — 이후 확대는 그대로 가능)
 */
export function resetPageZoom(): void {
  const vv = window.visualViewport;
  if (!vv || vv.scale <= 1.01) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const orig = meta.getAttribute('content') ?? 'width=device-width, initial-scale=1';
  meta.setAttribute('content', `${orig.replace(/,\s*maximum-scale=[^,]*/g, '')}, maximum-scale=1`);
  window.setTimeout(() => meta.setAttribute('content', orig), 500);
}
