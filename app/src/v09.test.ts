/**
 * v0.9.2~v0.10 실사용 의견: 저장 위치 안내, 기기 간 맞추기(학습 계획 최신 우선), 계산 도구
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OneQDB } from './db';
import { buildBackup, parseBackup, restoreBackup } from './backup';
import { savePlanSettings, loadPlanSettings } from './engine';
import { deviceEnv, storagePlace } from './util';

let d: OneQDB;
let n = 0;
beforeEach(() => {
  d = new OneQDB(`v09-${++n}`);
});
afterEach(async () => {
  await d.delete();
});

const UA = {
  galaxy: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  galaxyTab: 'Mozilla/5.0 (Linux; Android 14; SM-X710N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
};

describe('저장 위치 안내(v0.9.2)', () => {
  it('기기·브라우저·설치 여부를 가린다', () => {
    expect(deviceEnv(UA.galaxy, 5)).toMatchObject({ os: 'android', kind: 'phone', browser: 'Chrome' });
    expect(deviceEnv(UA.galaxyTab, 5)).toMatchObject({ os: 'android', kind: 'tablet' });
    expect(deviceEnv(UA.iphone, 5, true)).toMatchObject({ os: 'ios', kind: 'phone', browser: 'Safari', standalone: true });
    expect(deviceEnv(UA.ipadDesktop, 5)).toMatchObject({ os: 'ios', kind: 'tablet' });
    expect(deviceEnv(UA.ipadDesktop, 0)).toMatchObject({ os: 'mac', kind: 'pc' });
    expect(deviceEnv(UA.edge, 0)).toMatchObject({ os: 'windows', kind: 'pc', browser: 'Edge', inApp: null });
    // 앱 안 브라우저(v0.10.1): 카카오톡·네이버 앱·안드로이드 웹뷰·아이폰의 Safari 표시 없는 화면
    expect(deviceEnv(UA.galaxy.replace('Mobile Safari/537.36', 'Mobile Safari/537.36 KAKAOTALK 25.8.0'), 5).inApp).toBe('kakao');
    expect(deviceEnv(UA.iphone.replace('Safari/604.1', 'NAVER(inapp; search; 2000; 12.9.1)'), 5).inApp).toBe('naver');
    expect(deviceEnv(UA.galaxy.replace('(Linux; Android 14; SM-S918N)', '(Linux; Android 14; SM-S918N; wv)'), 5).inApp).toBe('other');
    expect(deviceEnv(UA.iphone.replace(' Safari/604.1', ''), 5, true).inApp).toBeNull(); // 홈 화면 앱은 Safari 표시가 없어도 앱 안 브라우저가 아님
    expect(deviceEnv(UA.iphone.replace(' Safari/604.1', ''), 5, false).inApp).toBe('other');
  });

  it('아이폰: 홈 화면 앱은 Safari와 따로, 브라우저 탭이면 경고', () => {
    const app = storagePlace(deviceEnv(UA.iphone, 5, true));
    expect(app.where).toBe('이 아이폰의 원큐합격 앱 안(Safari와 별도)');
    expect(app.warn).toBeUndefined();
    expect(app.risks.join(' ')).toContain('아이콘을 삭제');
    expect(storagePlace(deviceEnv(UA.galaxy, 5)).where).toBe('이 휴대폰의 Chrome 앱 안');
    const tab = storagePlace(deviceEnv(UA.iphone, 5, false));
    expect(tab.warn).toContain('따로 저장');
    expect(tab.risks.join(' ')).toContain('7일');
  });

  it('안드로이드·PC: 사이트 데이터 삭제는 영구 저장이어도 지움', () => {
    expect(storagePlace(deviceEnv(UA.galaxy, 5)).risks[0]).toContain('영구 저장이어도');
    const pc = storagePlace(deviceEnv(UA.edge, 0));
    expect(pc.where).toContain('이 PC의 Edge 안');
    expect(pc.risks.join(' ')).toContain('다른 브라우저');
  });
});

describe('다른 기기와 맞추기(v0.9.2)', () => {
  it('복원할 때 학습 계획은 더 최근에 바꾼 쪽이 이기고, 기기별 값(마지막 백업 시각)은 그대로', async () => {
    const other = new OneQDB(`v09-other-${n}`);
    try {
      await savePlanSettings('TEST', { examDate: '2027-04-01', dailyMinutes: 30 }, d);
      await d.settings.put({ key: 'lastBackupAt', value: 111 });
      await new Promise((r) => setTimeout(r, 5));
      // 다른 기기에서 나중에 계획을 바꿈
      await savePlanSettings('TEST', { examDate: '2027-04-01', dailyMinutes: 90 }, other);
      await other.settings.put({ key: 'lastBackupAt', value: 999 });
      const r = await restoreBackup(parseBackup((await buildBackup('test', other)).json), d);
      expect(r.plansUpdated).toBe(1);
      expect((await loadPlanSettings('TEST', d))!.dailyMinutes).toBe(90);
      expect((await d.settings.get('lastBackupAt'))!.value).toBe(111);
      // 반대로 오래된 계획은 덮어쓰지 않는다
      await new Promise((r) => setTimeout(r, 5));
      await savePlanSettings('TEST', { examDate: '2027-04-01', dailyMinutes: 120 }, d);
      const r2 = await restoreBackup(parseBackup((await buildBackup('test', other)).json), d);
      expect(r2.plansUpdated).toBe(0);
      expect((await loadPlanSettings('TEST', d))!.dailyMinutes).toBe(120);
    } finally {
      await other.delete();
    }
  });
});

describe('설치 안내(v0.10.1)', () => {
  it('앱 안 브라우저에서 바깥 브라우저로 여는 주소', async () => {
    const { externalOpenUrl } = await import('./install');
    const url = 'https://hoonie2026.github.io/OneQ-Ace/';
    expect(externalOpenUrl('kakao', 'ios', url)).toBe('kakaotalk://web/openExternal?url=https%3A%2F%2Fhoonie2026.github.io%2FOneQ-Ace%2F');
    expect(externalOpenUrl('naver', 'android', url)).toBe('intent://hoonie2026.github.io/OneQ-Ace/#Intent;scheme=https;package=com.android.chrome;end');
    expect(externalOpenUrl('naver', 'ios', url)).toBeNull();
  });
});

describe('안드로이드 태블릿 데스크톱 모드(v0.10.2, 실기기 Z4)', () => {
  it('Linux x86_64 + 터치면 안드로이드 태블릿, 터치가 없으면 PC', () => {
    const ff = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';
    expect(deviceEnv(ff, 5)).toMatchObject({ os: 'android', kind: 'tablet', browser: 'Firefox' });
    expect(deviceEnv(ff, 0)).toMatchObject({ kind: 'pc' });
  });
});
