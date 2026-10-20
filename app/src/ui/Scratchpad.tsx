import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/**
 * 손글씨 메모장(v0.10 — 계산 과정 적기). 손가락·펜(Pointer Events). 펜을 한 번이라도 쓰면 그 뒤로는 손가락 터치를 무시해
 * 손바닥이 닿아도 그려지지 않는다. 사용자 결정: 저장하지 않고 문항을 넘기면 지운다(풀이 화면이 문항마다 새로 만든다).
 */
type Pt = [number, number, number]; // x, y(캔버스 CSS 픽셀), 굵기 배율(펜 압력)
interface Stroke {
  erase: boolean;
  pts: Pt[];
}

export function Scratchpad() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const penSeen = useRef(false);
  const [erase, setErase] = useState(false);
  const [count, setCount] = useState(0);

  const ink = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#142033';

  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ink();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const base = s.erase ? 22 : 2.4;
    if (s.pts.length === 1) {
      const [x, y, w] = s.pts[0];
      ctx.beginPath();
      ctx.arc(x, y, (base * w) / 2, 0, Math.PI * 2);
      ctx.fillStyle = ink();
      ctx.fill();
      return;
    }
    for (let i = 1; i < s.pts.length; i++) {
      const [x0, y0] = s.pts[i - 1];
      const [x1, y1, w] = s.pts[i];
      ctx.lineWidth = base * w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  };

  const redraw = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of strokes.current) drawStroke(ctx, s);
  };

  // 패널 크기가 바뀌면 캔버스를 다시 맞추고 다시 그림(가로·세로 전환, 창 크기)
  useEffect(() => {
    const wrap = wrapRef.current;
    const c = canvasRef.current;
    if (!wrap || !c) return;
    const fit = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      redraw();
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(wrap);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', redraw);
    return () => {
      ro?.disconnect();
      mq.removeEventListener?.('change', redraw);
    };
  }, []);

  const pos = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    const p = e.pointerType === 'pen' && e.pressure > 0 ? 0.6 + e.pressure * 0.9 : 1;
    return [e.clientX - r.left, e.clientY - r.top, p];
  };

  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'pen') penSeen.current = true;
    else if (e.pointerType === 'touch' && penSeen.current) return; // 펜을 쓰는 중이면 손바닥 무시
    if (e.button > 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current = { erase, pts: [pos(e)] };
  };
  const move = (e: React.PointerEvent) => {
    const s = current.current;
    if (!s) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
    const ctx = canvasRef.current!.getContext('2d')!;
    for (const ev of events) {
      const r = canvasRef.current!.getBoundingClientRect();
      const p: Pt = [ev.clientX - r.left, ev.clientY - r.top, ev.pointerType === 'pen' && ev.pressure > 0 ? 0.6 + ev.pressure * 0.9 : 1];
      const prev = s.pts[s.pts.length - 1];
      s.pts.push(p);
      drawStroke(ctx, { erase: s.erase, pts: [prev, p] });
    }
  };
  const up = () => {
    const s = current.current;
    if (!s) return;
    current.current = null;
    strokes.current.push(s);
    if (s.pts.length === 1) redraw();
    setCount(strokes.current.length);
  };

  const undo = () => {
    strokes.current.pop();
    setCount(strokes.current.length);
    redraw();
  };
  const clear = () => {
    strokes.current = [];
    setCount(0);
    redraw();
  };

  return (
    <div className="pad" data-testid="scratchpad">
      <div className="pad-tools">
        <button type="button" className={`chip-btn${!erase ? ' on' : ''}`} onClick={() => setErase(false)} aria-pressed={!erase}>
          <Icon name="pencil" size={16} /> 펜
        </button>
        <button type="button" className={`chip-btn${erase ? ' on' : ''}`} onClick={() => setErase(true)} aria-pressed={erase}>
          지우개
        </button>
        <span className="pad-gap" />
        <button type="button" className="chip-btn" onClick={undo} disabled={count === 0} aria-label="되돌리기">
          <Icon name="reset-zoom" size={16} /> 되돌리기
        </button>
        <button type="button" className="chip-btn" onClick={clear} disabled={count === 0} data-testid="pad-clear">
          모두 지우기
        </button>
      </div>
      <div className="pad-area" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label="계산 메모(손글씨)"
          data-testid="pad-canvas"
          data-strokes={count}
        />
        {count === 0 && <p className="pad-hint">손가락이나 펜으로 계산 과정을 적으세요. 다음 문항으로 넘어가면 지워집니다.</p>}
      </div>
    </div>
  );
}
