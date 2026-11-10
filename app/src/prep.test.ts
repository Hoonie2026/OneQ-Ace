import { describe, expect, it } from 'vitest';
import { PREP_ASSET, PREP_DOWNLOAD_URL, prepOffer } from './prep';
import { deviceEnv } from './util';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

describe('전처리기 받기(D1)', () => {
  it('Windows PC는 받기, 맥은 Windows 전용 안내, 폰은 PC에서', () => {
    expect(prepOffer(deviceEnv(UA.winChrome, 0, false))).toBe('download');
    expect(prepOffer(deviceEnv(UA.winEdge, 0, true))).toBe('download'); // 설치한 PC 앱 창에서도
    expect(prepOffer(deviceEnv(UA.mac, 0, false))).toBe('windows-only');
    expect(prepOffer(deviceEnv(UA.mac, 5, false))).toBe('use-pc'); // 아이패드 데스크톱 모드
    expect(prepOffer(deviceEnv(UA.android, 5, false))).toBe('use-pc');
    expect(prepOffer(deviceEnv(UA.iphone, 5, false))).toBe('use-pc');
  });

  it('받기 주소는 최신 릴리스의 고정 파일 이름(릴리스 워크플로와 같은 이름)', () => {
    expect(PREP_DOWNLOAD_URL).toBe('https://github.com/Hoonie2026/OneQ-Ace/releases/latest/download/OneQ-Prep-win64.zip');
    expect(PREP_ASSET).toBe('OneQ-Prep-win64.zip');
  });
});
