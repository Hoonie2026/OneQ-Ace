/**
 * 묶음 파일(v0.10.8): 문제팩 여러 개(oneq-…zip)를 zip 하나에 담은 파일.
 * 클라우드(구글 드라이브)에서 30여 개를 한꺼번에 고르면 기기가 내려받지 못하는 일이 있어, 파일 하나로 옮기게 한다.
 * 전처리기가 oneq-<종목>-bundle-<첫해>-<끝해>.zip으로 만든다. 문제팩 자체에는 manifest.json이 있고 묶음에는 없다.
 */
import { unzipSync } from 'fflate';

export interface BundleEntry {
  name: string;
  blob: Blob;
}

/** 묶음이면 안의 팩들, 아니면 null(보통 문제팩 또는 다른 파일) */
export function unbundle(data: Uint8Array): BundleEntry[] | null {
  let files: Record<string, Uint8Array>;
  try {
    // 이름만 먼저 보고(내용은 풀지 않음) 묶음인지 판단
    let isPack = false;
    let hasZip = false;
    unzipSync(data, {
      filter: (f) => {
        if (f.name === 'manifest.json') isPack = true;
        if (/\.zip$/i.test(f.name)) hasZip = true;
        return false;
      },
    });
    if (isPack || !hasZip) return null;
    files = unzipSync(data, { filter: (f) => /\.zip$/i.test(f.name) && !f.name.startsWith('__MACOSX/') });
  } catch {
    return null;
  }
  return Object.keys(files)
    .sort()
    .map((path) => ({ name: path.split('/').pop() ?? path, blob: new Blob([files[path] as BlobPart], { type: 'application/zip' }) }));
}
