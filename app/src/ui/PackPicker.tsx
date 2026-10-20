import { useEffect, useRef, useState } from 'react';
import { clearPick, markPickStart, PICK_FAIL_MS, PICK_WAIT_NOTE, PICK_WAIT_SHOW_MS, PICK_WAIT_TIP } from '../importFlow';

/**
 * 문제팩(zip) 파일 선택 버튼. iOS 파일 선택기가 낯선 확장자를 회색 처리하지 않도록 .zip만 지정(5.3).
 * 선택기를 열 때 표시를 남기고 닫힐 때 지운다 — 클라우드 파일을 내려받다 앱이 다시 시작되면 안내하기 위해(v0.10.7).
 * 오래 열어 두었다가 파일 없이 돌아오면(드라이브 여러 개를 고른 뒤 기기가 받지 못함) onPickFailed(v0.10.8).
 * 선택기에서 앱으로 돌아왔는데 파일이 아직 안 오면(기기가 클라우드 파일을 내려받는 중) 대기 안내 창(v0.10.8)
 */
export function PackPicker(props: { busy: boolean; onFiles: (files: File[], pickMs: number | null) => void; onPickFailed?: () => void; primary?: boolean; small?: boolean }) {
  // 선택기에서 [취소] 또는 파일 없이 돌아옴: React 18에는 onCancel이 없어 직접 단다(Chrome 113+, Safari 16.4+).
  // 오래 열어 두었다가 파일 없이 끝나면 사용자의 취소가 아니라 기기가 파일을 받지 못한 것으로 보고 안내한다
  const ref = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const failRef = useRef(props.onPickFailed);
  failRef.current = props.onPickFailed;
  const [waitSince, setWaitSince] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const el = ref.current;
    let timer = 0;
    const endedWithoutFiles = () => {
      if (!picking.current) return;
      picking.current = false;
      window.clearTimeout(timer);
      setWaitSince(null);
      const ms = clearPick();
      if (ms !== null && ms >= PICK_FAIL_MS) failRef.current?.();
    };
    // 선택기에서 앱 화면으로 돌아왔는데 파일이 아직 안 왔으면 → 잠시 뒤 대기 안내(PC는 곧바로 와서 안 뜸)
    const onBack = () => {
      if (!picking.current || document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (picking.current) {
          setHidden(false);
          setWaitSince(Date.now());
        }
      }, PICK_WAIT_SHOW_MS);
    };
    el?.addEventListener('cancel', endedWithoutFiles);
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.clearTimeout(timer);
      el?.removeEventListener('cancel', endedWithoutFiles);
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, []);
  useEffect(() => {
    if (waitSince === null) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [waitSince]);
  const waited = waitSince === null ? 0 : Math.max(0, Math.round((Date.now() - waitSince) / 1000));
  const cls = `btn${props.primary ? ' btn-primary btn-block btn-big' : ''}${props.small ? ' btn-small' : ''}${props.busy ? ' disabled' : ''}`;
  return (
    <>
    <label className={cls}>
      {props.busy ? '가져오는 중…' : '문제팩 가져오기'}
      <input
        ref={ref}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        multiple
        hidden
        disabled={props.busy}
        data-testid="pack-input"
        onClick={() => {
          picking.current = true;
          markPickStart();
        }}
        onChange={(e) => {
          picking.current = false;
          setWaitSince(null);
          const pickMs = clearPick();
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) props.onFiles(files, pickMs);
        }}
      />
    </label>
    {waitSince !== null && !hidden && (
      <div className="modal-back imp-back" role="dialog" aria-modal="true" aria-labelledby="pick-wait-title" data-testid="pick-wait">
        <section className="modal imp">
          <h2 id="pick-wait-title">고른 파일을 기기가 받는 중</h2>
          <p className="imp-count">
            <span className="imp-phase">기다리는 중…</span>
            <span className="imp-time">{Math.floor(waited / 60) ? `${Math.floor(waited / 60)}분 ` : ''}{waited % 60}초</span>
          </p>
          <div className="imp-bar imp-bar-wait" aria-hidden="true">
            <span />
          </div>
          <p className="imp-file">{PICK_WAIT_NOTE}</p>
          <p className="imp-note">{PICK_WAIT_TIP}</p>
          <button className="btn btn-block" onClick={() => setHidden(true)} data-testid="pick-wait-hide">
            이 안내 닫기(계속 받음)
          </button>
        </section>
      </div>
    )}
    </>
  );
}
