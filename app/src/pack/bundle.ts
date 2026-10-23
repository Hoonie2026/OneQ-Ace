/**
 * 묶음 파일(v0.10.8): 문제팩 여러 개(oneq-…zip)를 zip 하나에 담은 파일.
 * 클라우드(구글 드라이브)에서 30여 개를 한꺼번에 고르면 기기가 내려받지 못하는 일이 있어, 파일 하나로 옮기게 한다.
 * 전처리기가 oneq-<종목>-bundle-<첫해>-<끝해>.zip으로 만든다. 문제팩 자체에는 manifest.json이 있고 묶음에는 없다.
 */
import { unzipSync } from 'fflate';

export interface BundleEntry {
  name: string;
  /** 이 팩 하나만 꺼낸다(부를 때 풀기 — 묶음 전체를 한 번에 풀지 않아 큰 묶음도 폰에서 메모리가 넘치지 않게, ADR 021 8절) */
  load: () => Blob;
}

/** 묶음이면 안의 팩들(아직 꺼내지 않은 목록), 아니면 null(보통 문제팩 또는 다른 파일) */
export function unbundle(data: Uint8Array): BundleEntry[] | null {
  const names: string[] = [];
  try {
    // 이름만 먼저 본다(내용은 풀지 않음)
    let isPack = false;
    unzipSync(data, {
      filter: (f) => {
        if (f.name === 'manifest.json') isPack = true;
        if (/\.zip$/i.test(f.name) && !f.name.startsWith('__MACOSX/')) names.push(f.name);
        return false;
      },
    });
    if (isPack || !names.length) return null;
  } catch {
    return null;
  }
  return names.sort().map((path) => ({
    name: path.split('/').pop() ?? path,
    load: () => {
      const one = unzipSync(data, { filter: (f) => f.name === path });
      return new Blob([one[path] as BlobPart], { type: 'application/zip' });
    },
  }));
}
