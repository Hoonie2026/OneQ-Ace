import { useRef, useState } from 'react';
import { CalcError, evaluate, formatNumber, toDMS, type AngleMode } from '../calc/expr';

/**
 * 공학용 계산기(v0.10). 큐넷 허용 공학용 계산기에서 필기 계산 문제에 쓰는 기능만 — 측량에 꼭 필요한 도·분·초와 Pol·Rec 포함.
 * SHIFT를 누르면 키 위 작은 글자 기능(sin⁻¹, 10ˣ, ∛, Pol, Rec, 쉼표 등). 계산 기록은 풀이 묶음 동안 남는다.
 */
interface Key {
  label: string;
  /** 넣을 글자(없으면 action) */
  ins?: string;
  shift?: { label: string; ins?: string; act?: Action };
  act?: Action;
  cls?: string;
  aria?: string;
}
type Action = 'shift' | 'mode' | 'dms' | 'toDms' | 'del' | 'ac' | 'eq';

const KEYS: Key[] = [
  { label: 'SHIFT', act: 'shift', cls: 'k-fn' },
  { label: 'DEG', act: 'mode', cls: 'k-fn', aria: '각도 단위 바꾸기' },
  { label: '(', ins: '(', shift: { label: ',', ins: ',' } },
  { label: ')', ins: ')' },
  { label: '°′″', act: 'dms', shift: { label: '→도분초', act: 'toDms' }, aria: '도 분 초' },
  { label: 'sin', ins: 'sin(', shift: { label: 'sin⁻¹', ins: 'sin⁻¹(' } },
  { label: 'cos', ins: 'cos(', shift: { label: 'cos⁻¹', ins: 'cos⁻¹(' } },
  { label: 'tan', ins: 'tan(', shift: { label: 'tan⁻¹', ins: 'tan⁻¹(' } },
  { label: 'log', ins: 'log(', shift: { label: '10ˣ', ins: '10^(' } },
  { label: 'ln', ins: 'ln(', shift: { label: 'eˣ', ins: 'e^(' } },
  { label: '√', ins: '√(', shift: { label: '∛', ins: '∛(' } },
  { label: 'x²', ins: '²', shift: { label: 'x³', ins: '³' } },
  { label: 'xʸ', ins: '^' },
  { label: 'π', ins: 'π', shift: { label: 'e', ins: 'e' } },
  { label: 'Ans', ins: 'Ans' },
  { label: '7', ins: '7', cls: 'k-num' },
  { label: '8', ins: '8', cls: 'k-num' },
  { label: '9', ins: '9', cls: 'k-num' },
  { label: 'DEL', act: 'del', cls: 'k-del', aria: '한 글자 지우기' },
  { label: 'AC', act: 'ac', cls: 'k-del', aria: '모두 지우기' },
  { label: '4', ins: '4', cls: 'k-num' },
  { label: '5', ins: '5', cls: 'k-num' },
  { label: '6', ins: '6', cls: 'k-num' },
  { label: '×', ins: '×', cls: 'k-op' },
  { label: '÷', ins: '÷', cls: 'k-op' },
  { label: '1', ins: '1', cls: 'k-num' },
  { label: '2', ins: '2', cls: 'k-num' },
  { label: '3', ins: '3', cls: 'k-num' },
  { label: '+', ins: '+', cls: 'k-op', shift: { label: 'Pol', ins: 'Pol(' } },
  { label: '−', ins: '-', cls: 'k-op', shift: { label: 'Rec', ins: 'Rec(' } },
  { label: '0', ins: '0', cls: 'k-num' },
  { label: '.', ins: '.', cls: 'k-num' },
  { label: '×10ˣ', ins: 'E', aria: '곱하기 10의 거듭제곱' },
  { label: '(−)', ins: '-', aria: '음수' },
  { label: '=', act: 'eq', cls: 'k-eq' },
];

interface Line {
  expr: string;
  out: string;
}

/** 풀이 화면을 오가도 각도 단위·기록은 그대로(모듈 안에 보관 — 앱을 닫으면 사라짐) */
const memo: { mode: AngleMode; ans: number; history: Line[] } = { mode: 'DEG', ans: 0, history: [] };

export function Calculator() {
  const [expr, setExpr] = useState('');
  const [out, setOut] = useState<string>('');
  const [err, setErr] = useState('');
  const [shift, setShift] = useState(false);
  const [mode, setMode] = useState<AngleMode>(memo.mode);
  const [history, setHistory] = useState<Line[]>(memo.history);
  const [dmsView, setDmsView] = useState(false);
  /** = 직후: 숫자를 누르면 새 식, 연산자를 누르면 Ans에 이어서 */
  const justEvaluated = useRef(false);
  const lastValue = useRef<number | null>(null);

  const insert = (txt: string) => {
    setErr('');
    setDmsView(false);
    setExpr((cur) => {
      if (justEvaluated.current) {
        justEvaluated.current = false;
        if (/^[+\-×÷^²³]/.test(txt)) return `Ans${txt}`;
        return txt;
      }
      return cur + txt;
    });
  };

  // °′″ 한 키: 숫자 뒤에 차례로 ° → ′ → ″ (계산기와 같은 입력)
  const dmsKey = () => {
    setExpr((cur) => {
      const tail = /[\d.°′″]*$/.exec(cur)![0];
      if (!/[\d.]$/.test(tail) || tail.includes('″')) return cur; // 숫자 뒤에서만, 초까지 넣었으면 그만
      if (tail.includes('′')) return `${cur}″`;
      if (tail.includes('°')) return `${cur}′`;
      return `${cur}°`;
    });
    justEvaluated.current = false;
  };

  const run = () => {
    if (!expr.trim()) return;
    try {
      const r = evaluate(expr, mode, memo.ans);
      const shown = r.pair ? `${r.pair.a}=${formatNumber(r.value)}, ${r.pair.b}=${formatNumber(r.pair.second)}` : formatNumber(r.value);
      memo.ans = r.value;
      lastValue.current = r.value;
      setOut(shown);
      setErr('');
      const h = [{ expr, out: shown }, ...memo.history].slice(0, 6);
      memo.history = h;
      setHistory(h);
      justEvaluated.current = true;
    } catch (e) {
      setErr(e instanceof CalcError ? e.message : '식 오류');
    }
  };

  const press = (k: Key) => {
    const use = shift && k.shift ? k.shift : k;
    if (k.act !== 'shift') setShift(false);
    if (use.ins !== undefined) return insert(use.ins);
    switch (use.act ?? k.act) {
      case 'shift':
        return setShift((v) => !v);
      case 'mode': {
        const m: AngleMode = mode === 'DEG' ? 'RAD' : 'DEG';
        memo.mode = m;
        return setMode(m);
      }
      case 'dms':
        return dmsKey();
      case 'toDms':
        if (lastValue.current !== null) setDmsView((v) => !v);
        return;
      case 'del':
        justEvaluated.current = false;
        setErr('');
        return setExpr((cur) => cur.replace(/(sin⁻¹\(|cos⁻¹\(|tan⁻¹\(|sin\(|cos\(|tan\(|log\(|ln\(|10\^\(|e\^\(|√\(|∛\(|Pol\(|Rec\(|Ans|.)$/u, ''));
      case 'ac':
        justEvaluated.current = false;
        setErr('');
        setOut('');
        setDmsView(false);
        return setExpr('');
      case 'eq':
        return run();
    }
  };

  // PC 키보드: 숫자·연산자·Enter·Backspace(풀이 화면 단축키와 겹치지 않게 계산기에 초점이 있을 때만)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (/^[0-9.+\-*/^()]$/.test(k)) insert(k === '*' ? '×' : k === '/' ? '÷' : k);
    else if (k === 'Enter' || k === '=') run();
    else if (k === 'Backspace') press(KEYS.find((x) => x.act === 'del')!);
    else if (k === 'Escape') press(KEYS.find((x) => x.act === 'ac')!);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const display = dmsView && lastValue.current !== null ? toDMS(lastValue.current) : out;

  return (
    <div className="calc" tabIndex={0} onKeyDown={onKeyDown} data-testid="calculator" aria-label="계산기">
      <div className="calc-screen">
        <div className="calc-flags">
          <span>{mode}</span>
          {shift && <span className="on">SHIFT</span>}
        </div>
        <div className="calc-expr" data-testid="calc-expr">
          {expr || ' '}
        </div>
        <div className={`calc-out${err ? ' err' : ''}`} data-testid="calc-out" aria-live="polite">
          {err || display || ' '}
        </div>
      </div>
      <div className={`calc-keys${shift ? ' is-shift' : ''}`}>
        {KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            className={`calc-key ${k.cls ?? ''}`}
            onClick={() => press(k)}
            aria-label={k.aria ?? (shift && k.shift ? k.shift.label : k.label)}
            data-key={k.label}
          >
            {k.shift && <small>{k.shift.label}</small>}
            <span>{k.act === 'mode' ? mode : k.label}</span>
          </button>
        ))}
      </div>
      {history.length > 0 && (
        <ul className="calc-history" aria-label="계산 기록">
          {history.map((h, i) => (
            <li key={i}>
              <button type="button" onClick={() => insert(h.out.split(',')[0].replace(/^.*=/, '').replace('×10^', 'E'))}>
                <span>{h.expr}</span>
                <b>{h.out}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
