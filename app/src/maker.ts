/**
 * 원큐합격 문제팩 생성기 받기(PREP-PLAN-v0.5 D1, 설치 루트 재설계 — 사용자 2026-11-12 세션 #19).
 * 설치는 학습앱에서 시작한다: 학습앱을 설치하고 처음 열면 [문제팩 가져오기]가 메인,
 * 그 아래 서브로 "문제팩이 없으면 생성기를 PC에 설치" — Windows PC 학습앱만 받기 링크, 휴대폰·태블릿은 안내 문구만.
 * 설치 프로그램(Setup.exe)과 설치 없는 zip을 GitHub Releases에 둔다(.github/workflows/release-prep.yml이 Windows에서 빌드해 올림).
 * "latest/download/고정 이름"이라 새 판을 올려도 이 주소는 그대로다.
 */
import type { DeviceEnv } from './util';

export const MAKER_NAME = '원큐합격 문제팩 생성기';
/** 설치 프로그램(사용자 2026-11-11 B안) — 기본 받기 */
export const MAKER_SETUP_ASSET = 'OneQ-PackMaker-Setup.exe';
/** 설치 없이 쓰는 zip — 설치가 막힌 PC용 보조 */
export const MAKER_ASSET = 'OneQ-PackMaker-win64.zip';
export const MAKER_REPO = 'https://github.com/Hoonie2026/OneQ-Ace';
export const MAKER_SETUP_URL = `${MAKER_REPO}/releases/latest/download/${MAKER_SETUP_ASSET}`;
export const MAKER_DOWNLOAD_URL = `${MAKER_REPO}/releases/latest/download/${MAKER_ASSET}`;
export const MAKER_RELEASES_URL = `${MAKER_REPO}/releases/latest`;

/** 이 기기에서 생성기 안내를 어떻게 보일지 — 받기 링크는 Windows PC에서만(휴대폰에는 링크를 주지 않음) */
export type MakerOffer = 'download' | 'windows-only' | 'use-pc';

export function makerOffer(env: DeviceEnv): MakerOffer {
  if (env.kind !== 'pc') return 'use-pc'; // 휴대폰·태블릿: PC에 학습앱을 설치한 뒤 거기서 생성기를 설치
  return env.os === 'windows' ? 'download' : 'windows-only';
}
