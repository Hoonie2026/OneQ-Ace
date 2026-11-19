import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const MIN = 1;
const MAX = 4;
const DOUBLE_TAP_SCALE = 2.5;
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

/**
 * 문항 이미지 확대 보기(개발기준서 7.1): 두 손가락 확대, 두 번 탭 확대/원래대로, 한 손가락은 스크롤.
 * 확대는 이미지 폭을 바꾸고 스크롤 위치를 손가락 중심에 맞춘다(브라우저 화면 전체 확대와 달리 하단 버튼은 그대로).
 */
export function ZoomImage(props: { src: string | null; width: number; height: number; alt: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const [scale, setScaleState] = useState(1);

  /** 화면 좌표 (mx, my)(상자 기준)를 고정점으로 배율 변경 */
  const zoomAt = (next: number, mx: number, my: number, from = scaleRef.current) => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;
    next = clamp(next);
    const cx = (box.scrollLeft + mx) / from;
    const cy = (box.scrollTop + my) / from;
    scaleRef.current = next;
    inner.style.width = `${next * 100}%`;
    box.scrollLeft = cx * next - mx;
    box.scrollTop = cy * next - my;
  };

  const commit = () => setScaleState(Math.round(scaleRef.current * 100) / 100);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let pinch: { dist: number; scale: number; mx: number; my: number } | null = null;
    let tap: { x: number; y: number; t: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; t: number } | null = null;

    const rel = (t: Touch) => {
      const r = box.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const pa = rel(a);
        const pb = rel(b);
        pinch = { dist: dist(a, b), scale: scaleRef.current, mx: (pa.x + pb.x) / 2, my: (pa.y + pb.y) / 2 };
        tap = null;
      } else if (e.touches.length === 1) {
        const p = rel(e.touches[0]);
        tap = { ...p, t: performance.now(), moved: false };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault(); // 두 손가락 이동으로 화면이 같이 스크롤되지 않게
        const d = dist(e.touches[0], e.touches[1]);
        zoomAt((pinch.scale * d) / pinch.dist, pinch.mx, pinch.my);
      } else if (tap && e.touches.length === 1) {
        const p = rel(e.touches[0]);
        if (Math.hypot(p.x - tap.x, p.y - tap.y) > 12) tap.moved = true;
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        pinch = null;
        commit();
        return;
      }
      if (tap && !tap.moved && e.touches.length === 0 && performance.now() - tap.t < 300) {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(lastTap.x - tap.x, lastTap.y - tap.y) < 40) {
          e.preventDefault();
          zoomAt(scaleRef.current > 1.05 ? 1 : DOUBLE_TAP_SCALE, tap.x, tap.y);
          commit();
          lastTap = null;
        } else lastTap = { x: tap.x, y: tap.y, t: now };
      }
      tap = null;
    };
    const onDbl = (e: MouseEvent) => {
      const r = box.getBoundingClientRect();
      zoomAt(scaleRef.current > 1.05 ? 1 : DOUBLE_TAP_SCALE, e.clientX - r.left, e.clientY - r.top);
      commit();
    };
    box.addEventListener('touchstart', onStart, { passive: true });
    box.addEventListener('touchmove', onMove, { passive: false });
    box.addEventListener('touchend', onEnd, { passive: false });
    box.addEventListener('touchcancel', onEnd, { passive: false });
    box.addEventListener('dblclick', onDbl);
    return () => {
      box.removeEventListener('touchstart', onStart);
      box.removeEventListener('touchmove', onMove);
      box.removeEventListener('touchend', onEnd);
      box.removeEventListener('touchcancel', onEnd);
      box.removeEventListener('dblclick', onDbl);
    };
  }, []);

  const step = (k: number) => {
    const box = boxRef.current;
    if (!box) return;
    zoomAt(scaleRef.current * k, box.clientWidth / 2, box.clientHeight / 3);
    commit();
  };
  const reset = () => {
    zoomAt(1, 0, 0);
    commit();
  };

  return (
    <div className="zoom">
      <div className="zoom-box" ref={boxRef} data-testid="zoom-box">
        <div className="zoom-inner" ref={innerRef}>
          {props.src ? (
            <img src={props.src} alt={props.alt} draggable={false} style={{ aspectRatio: `${props.width} / ${props.height}` }} />
          ) : (
            <div className="zoom-placeholder" style={{ aspectRatio: `${props.width} / ${props.height}` }} />
          )}
        </div>
      </div>
      <div className="zoom-tools" aria-label="확대">
        {scale > 1.01 && (
          <button className="zoom-btn zoom-pct" onClick={reset} aria-label="원래 크기로">
            {Math.round(scale * 100)}% <Icon name="reset-zoom" size={15} />
          </button>
        )}
        <button className="zoom-btn" onClick={() => step(1 / 1.25)} disabled={scale <= MIN} aria-label="축소">
          <Icon name="minus" size={18} />
        </button>
        <button className="zoom-btn" onClick={() => step(1.25)} disabled={scale >= MAX} aria-label="확대">
          <Icon name="plus" size={18} />
        </button>
      </div>
    </div>
  );
}
