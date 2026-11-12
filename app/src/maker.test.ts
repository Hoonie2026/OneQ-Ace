import { describe, expect, it } from 'vitest';
import { MAKER_ASSET, MAKER_DOWNLOAD_URL, MAKER_SETUP_ASSET, MAKER_SETUP_URL, makerOffer } from './maker';
import { deviceEnv } from './util';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

describe('문제팩 생성기 받기(D1, 설치 루트 재설계)', () => {
  it('Windows PC만 받기, 맥은 Windows 전용 안내, 휴대폰·태블릿은 PC에서(링크 없음)', () => {
    expect(makerOffer(deviceEnv(UA.winChrome, 0, false))).toBe('download');
    expect(makerOffer(deviceEnv(UA.winEdge, 0, true))).toBe('download'); // 설치한 PC 학습앱 창
    expect(makerOffer(deviceEnv(UA.mac, 0, false))).toBe('windows-only');
    expect(makerOffer(deviceEnv(UA.mac, 5, false))).toBe('use-pc'); // 아이패드 데스크톱 모드
    expect(makerOffer(deviceEnv(UA.android, 5, true))).toBe('use-pc');
    expect(makerOffer(deviceEnv(UA.iphone, 5, true))).toBe('use-pc');
  });

  it('받기 주소는 최신 릴리스의 고정 파일 이름(릴리스 워크플로와 같은 이름)', () => {
    expect(MAKER_DOWNLOAD_URL).toBe('https://github.com/Hoonie2026/OneQ-Ace/releases/latest/download/OneQ-PackMaker-win64.zip');
    expect(MAKER_ASSET).toBe('OneQ-PackMaker-win64.zip');
    expect(MAKER_SETUP_URL).toBe('https://github.com/Hoonie2026/OneQ-Ace/releases/latest/download/OneQ-PackMaker-Setup.exe');
    expect(MAKER_SETUP_ASSET).toBe('OneQ-PackMaker-Setup.exe');
  });
});

describe('문제팩 고르기 형식(실기기 2026-11-12)', () => {
  it('안드로이드만 하나(.zip), 아이폰·아이패드·PC는 그대로(아이폰은 실기기에서 문제없음)', async () => {
    const { packAccept } = await import('./ui/PackPicker');
    expect(packAccept('android')).toBe('.zip');
    expect(packAccept('ios')).toBe('.zip,application/zip,application/x-zip-compressed');
    expect(packAccept('windows')).toBe('.zip,application/zip,application/x-zip-compressed');
    // 아이패드 데스크톱 모드(맥 UA + 터치)도 ios로 판정되어 그대로
    expect(deviceEnv('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 5, false).os).toBe('ios');
  });
});
