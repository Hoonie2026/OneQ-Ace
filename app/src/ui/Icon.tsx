/**
 * 선 아이콘(v0.9.1 — docs/screens/design-upgrade-guide.md 작업 1). v0.9.0의 손으로 그린 직선 아이콘은 설정이 '슬라이더',
 * 성적이 '산(山)'처럼 보였다(실기기 캡처) → Lucide Icons(ISC 라이선스) 경로로 교체. 24×24 격자, 선 굵기 1.85, 둥근 끝,
 * 글자 색(currentColor)을 따른다. 기존 20개 이름은 그대로 두고 글자 기호(−, +, ↺, ▾)를 대신할 이름을 더했다
 */
const PATHS = {
  // ── 기존 20개 키 (100% 하위 호환) ──
  close: 'M18 6L6 18M6 6l12 12',
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  chart:
    'M5 12h2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM11 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM17 8h2a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
  search: 'M11 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM21 21l-4.3-4.3',
  pencil:
    'M12 20h9M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z',
  note: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z M14 2v4a2 2 0 0 0 2 2h4 M10 9H8 M16 13H8 M16 17H8',
  book: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  repeat: 'M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3',
  alert: 'M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01',
  arrow: 'M5 12h14M12 5l7 7-7 7',
  check: 'M20 6L9 17l-5-5',
  trend: 'M3 3v16a2 2 0 0 0 2 2h16M7 6c1.5 6 5 10 13 11',
  calendar:
    'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01',
  scale:
    'M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2',
  shuffle:
    'M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22M18 2l4 4-4 4M2 6h1.9c1.5 0 2.9.9 3.6 2.2M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8M18 14l4 4-4 4',
  target:
    'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM12 6a6 6 0 1 0 0 12a6 6 0 1 0 0-12zM12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  flask:
    'M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2M8.5 2h7M7 16h10',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',

  // ── v0.9.1 확장 키 (특수문자·유니코드 기호 대체용) ──
  'search-ai': 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM19.5 19.5l-4.3-4.3M19 3v4M17 5h4',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M18 15l-6-6-6 6',
  minus: 'M5 12h14',
  plus: 'M5 12h14M12 5v14',
  'reset-zoom': 'M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
  trophy:
    'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z',
  'cpu-fsrs':
    'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 9h6v6H9zM15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2',
  flame:
    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z',
  'alert-circle': 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM12 8v4M12 16h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; className?: string; label?: string }) {
  const s = props.size ?? 22;
  return (
    <svg
      className={`ico${props.className ? ` ${props.className}` : ''}`}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props.label ? undefined : true}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}

/** 모든 화면 머리의 뒤로 단추 */
export function BackButton(props: { label: string; onClick: () => void; testId?: string; aria?: string }) {
  return (
    <button className="back-btn" onClick={props.onClick} aria-label={props.aria ?? '뒤로'} data-testid={props.testId}>
      <Icon name="back" size={20} />
      <span>{props.label}</span>
    </button>
  );
}

/**
 * 홈 머리의 1Q 로고(v0.9.1). 홈 화면에 설치된 앱 아이콘(public/favicon.svg·pwa-*.png: 남색 바탕·흰 1Q·노란 밑줄)과 같은 모양.
 * 안내서 시안(파란 그라데이션 + 금색 체크)은 설치 아이콘과 달라져 쓰지 않았다
 */
export function BrandLogo(props: { size?: number }) {
  const s = props.size ?? 44;
  return (
    <svg className="brand-logo" width={s} height={s} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#0f1d2e" />
      <text
        x="32"
        y="39"
        textAnchor="middle"
        fill="#ffffff"
        fontFamily="'Pretendard Variable', Pretendard, system-ui, sans-serif"
        fontSize="27"
        fontWeight="800"
        letterSpacing="-1"
      >
        1Q
      </text>
      <rect x="15" y="47" width="34" height="5" rx="2.5" fill="#f2b830" />
    </svg>
  );
}
