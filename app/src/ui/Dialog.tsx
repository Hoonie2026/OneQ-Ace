import { useEffect, useState } from 'react';

/**
 * 앱 안 확인 창(v0.7.2 — 실기기 의견). 브라우저 기본 창(window.confirm/prompt)은 위에 앱 주소(github.io)가 찍히고
 * 글자가 작아 고칠 수 없으므로, 모든 확인·안내를 이 창으로 띄운다. <DialogHost/>는 App에 하나만 둔다.
 */
interface Req {
  id: number;
  title?: string;
  message: string;
  okText: string;
  cancelText: string | null; // null이면 확인 단추만(안내)
  danger: boolean;
  copyText?: string;
  resolve: (ok: boolean) => void;
}

let seq = 0;
let push: ((r: Req) => void) | null = null;
const queue: Req[] = [];

function open(r: Omit<Req, 'id' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    const req = { ...r, id: ++seq, resolve };
    if (push) push(req);
    else queue.push(req);
  });
}

/** 확인 창: [취소] [확인]. 확인이면 true */
export function askConfirm(message: string, opts: { title?: string; okText?: string; cancelText?: string; danger?: boolean } = {}): Promise<boolean> {
  return open({ title: opts.title, message, okText: opts.okText ?? '확인', cancelText: opts.cancelText ?? '취소', danger: !!opts.danger });
}

/** 안내 창: [확인]만. 복사할 글을 길게 눌러 고를 수 있게 보여 줄 수도 있다 */
export function showNotice(message: string, opts: { title?: string; copyText?: string } = {}): Promise<boolean> {
  return open({ title: opts.title, message, okText: '확인', cancelText: null, danger: false, copyText: opts.copyText });
}

export function DialogHost() {
  const [list, setList] = useState<Req[]>([]);
  useEffect(() => {
    push = (r) => setList((l) => [...l, r]);
    if (queue.length) setList((l) => [...l, ...queue.splice(0)]);
    return () => {
      push = null;
    };
  }, []);
  const cur = list[0];
  if (!cur) return null;
  const close = (ok: boolean) => {
    cur.resolve(ok);
    setList((l) => l.slice(1));
  };
  return (
    <div className="modal-back dlg-back" role="alertdialog" aria-modal="true" aria-labelledby={`dlg-${cur.id}`} data-testid="dialog">
      <section className="modal dlg">
        {cur.title && <h2 id={`dlg-${cur.id}`}>{cur.title}</h2>}
        <p className="dlg-msg" id={cur.title ? undefined : `dlg-${cur.id}`}>
          {cur.message}
        </p>
        {cur.copyText && <textarea className="dlg-copy" readOnly value={cur.copyText} rows={6} onFocus={(e) => e.currentTarget.select()} />}
        <div className={`dlg-actions${cur.cancelText ? '' : ' one'}`}>
          {cur.cancelText && (
            <button className="btn dlg-btn" onClick={() => close(false)} data-testid="dialog-cancel">
              {cur.cancelText}
            </button>
          )}
          <button className={`btn dlg-btn ${cur.danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={() => close(true)} autoFocus data-testid="dialog-ok">
            {cur.okText}
          </button>
        </div>
      </section>
    </div>
  );
}
