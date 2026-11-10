/**
 * 전처리기 받기(PREP-PLAN-v0.5 D1, ADR 021 7절 "통합 배포 = 주소 하나").
 * 앱 주소 하나로: PC(Windows)로 열면 [전처리기 받기] + [이 PC에 학습앱 설치], 폰으로 열면 앱 설치.
 * 실행파일은 GitHub Releases에 둔다(.github/workflows/release-prep.yml이 Windows에서 빌드해 올림).
 * "latest/download/고정 이름"이라 새 판을 올려도 이 주소는 그대로다.
 */
import type { DeviceEnv } from './util';

export const PREP_ASSET = 'OneQ-Prep-win64.zip';
export const PREP_REPO = 'https://github.com/Hoonie2026/OneQ-Ace';
export const PREP_DOWNLOAD_URL = `${PREP_REPO}/releases/latest/download/${PREP_ASSET}`;
export const PREP_RELEASES_URL = `${PREP_REPO}/releases/latest`;

/** 이 기기에서 전처리기 안내를 어떻게 보일지 */
export type PrepOffer = 'download' | 'windows-only' | 'use-pc';

export function prepOffer(env: DeviceEnv): PrepOffer {
  if (env.kind !== 'pc') return 'use-pc'; // 휴대폰·태블릿: 문제팩은 PC에서 만든다
  return env.os === 'windows' ? 'download' : 'windows-only';
}
