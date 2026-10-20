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
