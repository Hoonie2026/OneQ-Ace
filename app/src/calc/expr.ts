/**
 * 기사 시험용 공학 계산기의 수식 해석기(v0.10 — 실사용 의견: 스마트폰·태블릿에서 계산 문제를 풀 수 있게).
 * eval을 쓰지 않는 재귀 하강 해석기. 큐넷 허용 공학용 계산기에서 필기 계산 문제에 쓰는 기능만:
 * 사칙, 괄호, 거듭제곱(^ ²), √ ∛, sin·cos·tan과 역함수(DEG/RAD), log·ln·10ˣ·eˣ, π·e, ×10ⁿ, Ans,
 * **도·분·초 입력**(50°20′15″ — 측량 필수), Pol(x,y)·Rec(r,θ)(좌표 ↔ 거리·방위각).
 *
 * 우선순위는 카시오 fx-570 계열과 같게: -2^2 = -4, 2π = 2×π(곱 생략), √ 뒤 괄호가 없으면 바로 뒤 값에만.
 */

export type AngleMode = 'DEG' | 'RAD';

export interface CalcResult {
  value: number;
  /** Pol·Rec처럼 값이 두 개인 함수의 둘째 값과 이름(r·θ / x·y) */
  pair?: { a: string; b: string; second: number };
}

export class CalcError extends Error {
  constructor(public kind: 'syntax' | 'math') {
    super(kind === 'syntax' ? '식 오류' : '수학 오류');
  }
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'op'; v: '+' | '-' | '×' | '÷' | '^' | ',' }
  | { t: 'post'; v: '²' | '³' | '°' | '′' | '″' }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'fn'; v: string }
  | { t: 'const'; v: 'π' | 'e' | 'Ans' };

export const FUNCS = ['sin⁻¹', 'cos⁻¹', 'tan⁻¹', 'sin', 'cos', 'tan', 'log', 'ln', '10^', 'e^', '√', '∛', 'Pol', 'Rec', 'Abs'] as const;

function tokenize(src: string): Tok[] {
  const s = src.replace(/\s+/g, '').replace(/\*/g, '×').replace(/\//g, '÷').replace(/−/g, '-').replace(/'/g, '′').replace(/"/g, '″');
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // ×10ⁿ: "E" (예: 1.2E-3)
    const num = /^(\d+\.?\d*|\.\d+)(E[+-]?\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    // 10^·e^는 괄호가 붙을 때만 함수(키로 "10^(" "e^(" 입력). "e^2"는 상수 e의 거듭제곱
    const fn = FUNCS.find((f) => s.startsWith(f, i) && (!f.endsWith('^') || s[i + f.length] === '('));
    if (fn) {
      out.push({ t: 'fn', v: fn });
      i += fn.length;
      continue;
    }
    if (s.startsWith('Ans', i)) {
      out.push({ t: 'const', v: 'Ans' });
      i += 3;
      continue;
    }
    if (c === 'π' || c === 'e') out.push({ t: 'const', v: c });
    else if ('+-×÷^,'.includes(c)) out.push({ t: 'op', v: c as '+' });
    else if ('²³°′″'.includes(c)) out.push({ t: 'post', v: c as '²' });
    else if (c === '(') out.push({ t: 'lp' });
    else if (c === ')') out.push({ t: 'rp' });
    else throw new CalcError('syntax');
    i++;
  }
  return out;
}

export function evaluate(src: string, mode: AngleMode = 'DEG', ans = 0): CalcResult {
  const toks = tokenize(src);
  // 닫는 괄호를 빠뜨려도 계산기처럼 끝에서 닫은 것으로 본다(args·primary가 끝에서 멈춤)
  let p = 0;
  let pair: CalcResult['pair'];
  const rad = (x: number) => (mode === 'DEG' ? (x * Math.PI) / 180 : x);
  const unrad = (x: number) => (mode === 'DEG' ? (x * 180) / Math.PI : x);
  const peek = () => toks[p];
  const fin = (x: number) => {
    if (!Number.isFinite(x)) throw new CalcError('math');
    return x;
  };

  const startsValue = (t: Tok | undefined) => !!t && (t.t === 'num' || t.t === 'lp' || t.t === 'fn' || t.t === 'const');

  function expr(): number {
    let v = term();
    for (;;) {
      const t = peek();
      if (t?.t === 'op' && (t.v === '+' || t.v === '-')) {
        p++;
        const r = term();
        v = t.v === '+' ? v + r : v - r;
      } else return v;
    }
  }
  function term(): number {
    let v = unary();
    for (;;) {
      const t = peek();
      if (t?.t === 'op' && (t.v === '×' || t.v === '÷')) {
        p++;
        const r = unary();
        if (t.v === '÷' && r === 0) throw new CalcError('math');
        v = t.v === '×' ? v * r : v / r;
      } else if (startsValue(t)) v *= power(); // 곱 생략: 2π, 3(4+1), 2sin30
      else return v;
    }
  }
  function unary(): number {
    const t = peek();
    if (t?.t === 'op' && (t.v === '-' || t.v === '+')) {
      p++;
      const v = unary();
      return t.v === '-' ? -v : v;
    }
    return power();
  }
  function power(): number {
    const base = postfix();
    const t = peek();
    if (t?.t === 'op' && t.v === '^') {
      p++;
      return fin(base ** unary()); // 오른쪽 결합, 지수의 음수 허용(2^-1)
    }
    return base;
  }
  function postfix(): number {
    let v = primary();
    // 도·분·초: 50°20′15″ — 숫자 뒤에 °가 오면 이어지는 숫자′·숫자″까지 한 값(도)으로
    if (peek()?.t === 'post' && (peek() as { v: string }).v === '°') {
      p++;
      let deg = v;
      for (const [mark, div] of [
        ['′', 60],
        ['″', 3600],
      ] as const) {
        const n = peek();
        const m = toks[p + 1];
        if (n?.t === 'num' && m?.t === 'post' && m.v === mark) {
          deg += n.v / div;
          p += 2;
        }
      }
      v = deg;
    }
    for (;;) {
      const t = peek();
      if (t?.t === 'post' && (t.v === '²' || t.v === '³')) {
        p++;
        v = v ** (t.v === '²' ? 2 : 3);
      } else return fin(v);
    }
  }
  function args(): number[] {
    const out = [expr()];
    while (peek()?.t === 'op' && (peek() as { v: string }).v === ',') {
      p++;
      out.push(expr());
    }
    if (peek()?.t === 'rp') p++;
    else if (p < toks.length) throw new CalcError('syntax');
    return out;
  }
  function primary(): number {
    const t = toks[p++];
    if (!t) throw new CalcError('syntax');
    if (t.t === 'num') return t.v;
    if (t.t === 'const') return t.v === 'π' ? Math.PI : t.v === 'e' ? Math.E : ans;
    if (t.t === 'lp') {
      const v = expr();
      if (peek()?.t === 'rp') p++;
      else if (p < toks.length) throw new CalcError('syntax');
      return v;
    }
    if (t.t === 'fn') {
      // √·∛ 뒤에 괄호가 없으면 바로 뒤 값 하나에만(√2×3 = 3√2)
      if ((t.v === '√' || t.v === '∛') && peek()?.t !== 'lp') {
        const x = postfix();
        if (t.v === '√' && x < 0) throw new CalcError('math');
        return t.v === '√' ? Math.sqrt(x) : Math.cbrt(x);
      }
      if (peek()?.t !== 'lp') throw new CalcError('syntax');
      p++;
      const a = args();
      const x = a[0];
      const one = () => {
        if (a.length !== 1) throw new CalcError('syntax');
      };
      switch (t.v) {
        case 'sin':
          one();
          return clean(Math.sin(rad(x)));
        case 'cos':
          one();
          return clean(Math.cos(rad(x)));
        case 'tan': {
          one();
          const c = Math.cos(rad(x));
          if (Math.abs(c) < 1e-12) throw new CalcError('math');
          return clean(Math.tan(rad(x)));
        }
        case 'sin⁻¹':
        case 'cos⁻¹':
          one();
          if (Math.abs(x) > 1) throw new CalcError('math');
          return unrad(t.v === 'sin⁻¹' ? Math.asin(x) : Math.acos(x));
        case 'tan⁻¹':
          one();
          return unrad(Math.atan(x));
        case 'log':
          if (a.length === 2) return logOf(a[1], a[0]); // log(밑, 진수)
          one();
          return logOf(x, 10);
        case 'ln':
          one();
          return logOf(x, Math.E);
        case '10^':
          one();
          return fin(10 ** x);
        case 'e^':
          one();
          return fin(Math.exp(x));
        case '√':
          one();
          if (x < 0) throw new CalcError('math');
          return Math.sqrt(x);
        case '∛':
          one();
          return Math.cbrt(x);
        case 'Abs':
          one();
          return Math.abs(x);
        case 'Pol': {
          // Pol(x, y) → r, θ(방향각 −180~180, 모드 단위)
          if (a.length !== 2) throw new CalcError('syntax');
          const r = Math.hypot(a[0], a[1]);
          pair = { a: 'r', b: 'θ', second: unrad(Math.atan2(a[1], a[0])) };
          return r;
        }
        case 'Rec': {
          // Rec(r, θ) → x, y
          if (a.length !== 2) throw new CalcError('syntax');
          pair = { a: 'x', b: 'y', second: clean(a[0] * Math.sin(rad(a[1]))) };
          return clean(a[0] * Math.cos(rad(a[1])));
        }
      }
    }
    throw new CalcError('syntax');
  }

  if (!toks.length) throw new CalcError('syntax');
  const value = expr();
  if (p < toks.length) throw new CalcError('syntax');
  return { value: fin(value), pair };
}

function logOf(x: number, base: number): number {
  if (x <= 0 || base <= 0 || base === 1) throw new CalcError('math');
  return clean(base === 10 ? Math.log10(x) : base === Math.E ? Math.log(x) : Math.log(x) / Math.log(base));
}

/** sin 30° = 0.49999999999999994 같은 부동소수 찌꺼기를 계산기처럼 정리 */
function clean(x: number): number {
  return Math.abs(x) < 1e-13 ? 0 : Number(x.toPrecision(14));
}

/** 계산기 표시: 유효숫자 10자리, 아주 크거나 작으면 ×10ⁿ */
export function formatNumber(x: number): string {
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e10 || a < 1e-9) {
    const [m, e] = x.toExponential(9).split('e');
    return `${trimZeros(m)}×10^${Number(e)}`;
  }
  return trimZeros(Number(x.toPrecision(10)).toFixed(10));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** 도(소수) → 도·분·초 표시: 89.17361 → 89°10′25″ (초는 소수 둘째 자리까지) */
export function toDMS(deg: number): string {
  const sign = deg < 0 ? '-' : '';
  let total = Math.round(Math.abs(deg) * 360000); // 1/100초 단위
  const cs = total % 6000;
  total = (total - cs) / 6000;
  const m = total % 60;
  const d = (total - m) / 60;
  const sec = (cs / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${sign}${d}°${m}′${sec}″`;
}
