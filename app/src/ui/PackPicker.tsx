import { useEffect, useRef } from 'react';
import { clearPick, markPickStart } from '../importFlow';

/**
 * 문제팩(zip) 파일 선택 버튼. iOS 파일 선택기가 낯선 확장자를 회색 처리하지 않도록 .zip만 지정(5.3).
 * 선택기를 열 때 표시를 남기고 닫힐 때 지운다 — 클라우드 파일을 내려받다 앱이 다시 시작되면 안내하기 위해(v0.10.7)
 */
export function PackPicker(props: { busy: boolean; onFiles: (files: File[], pickMs: number | null) => void; primary?: boolean; small?: boolean }) {
  // 선택기에서 [취소]: React 18에는 onCancel이 없어 직접 단다(Chrome 113+, Safari 16.4+)
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    const onCancel = () => void clearPick();
    el?.addEventListener('cancel', onCancel);
    return () => el?.removeEventListener('cancel', onCancel);
  }, []);
  const cls = `btn${props.primary ? ' btn-primary btn-block btn-big' : ''}${props.small ? ' btn-small' : ''}${props.busy ? ' disabled' : ''}`;
  return (
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
        onClick={() => markPickStart()}
        onChange={(e) => {
          const pickMs = clearPick();
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) props.onFiles(files, pickMs);
        }}
      />
    </label>
  );
}
