/**
 * 선 아이콘(v0.9.0 — 디자인 정리). 이모지(📊🔎📝⚙ 등)는 아이폰·안드로이드마다 모양·크기·색이 달라 화면이 들쭉날쭉해 보였다.
 * 24×24 격자, 선 굵기 2, 둥근 끝 — 글자 색(currentColor)을 따른다
 */
const PATHS: Record<string, string> = {
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  chart: 'M5 20V11M12 20V5M19 20v-7M3 20h18',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4-4',
  pencil: 'M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3',
  note: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6',
  book: 'M5 5a2 2 0 0 1 2-2h11v15H7a2 2 0 0 0-2 2zM5 20a2 2 0 0 0 2 2h11v-4M9 7h6',
  repeat: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4',
  alert: 'M12 3l10 18H2zM12 10v4M12 17.5v.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M5 12l5 5 9-10',
  trend: 'M3 4c2 8 6 13 18 15M3 20h18',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v5M16 3v5M8 14h3M8 17h3',
  scale: 'M12 4v16M6 20h12M4 8h16M4 8l-2 6h6zM20 8l-2 6h6z',
  shuffle: 'M3 7h4l10 10h4M18 14l3 3-3 3M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3',
  target: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 11.5v1',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 15h9',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
};

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
      strokeWidth={2}
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

/** 모든 화면 머리의 뒤로 단추(v0.9.0 — 홈 안 보기의 "← 홈"과 독립 화면의 "‹"가 달랐다) */
export function BackButton(props: { label: string; onClick: () => void; testId?: string; aria?: string }) {
  return (
    <button className="back-btn" onClick={props.onClick} aria-label={props.aria ?? '뒤로'} data-testid={props.testId}>
      <Icon name="back" size={20} />
      <span>{props.label}</span>
    </button>
  );
}
