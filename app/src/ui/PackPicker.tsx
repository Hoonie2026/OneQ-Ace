/** 문제팩(zip) 파일 선택 버튼. iOS 파일 선택기가 낯선 확장자를 회색 처리하지 않도록 .zip만 지정(5.3) */
export function PackPicker(props: { busy: boolean; onFiles: (files: File[]) => void; primary?: boolean; small?: boolean }) {
  const cls = `btn${props.primary ? ' btn-primary btn-block btn-big' : ''}${props.small ? ' btn-small' : ''}${props.busy ? ' disabled' : ''}`;
  return (
    <label className={cls}>
      {props.busy ? '가져오는 중…' : '문제팩 가져오기'}
      <input
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        multiple
        hidden
        disabled={props.busy}
        data-testid="pack-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) props.onFiles(files);
        }}
      />
    </label>
  );
}
