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
    expect(deviceEnv(UA.edge, 0)).toMatchObject({ os: 'windows', kind: 'pc', browser: 'Edge' });
  });

  it('아이폰: 홈 화면 앱은 Safari와 따로, 브라우저 탭이면 경고', () => {
    const app = storagePlace(deviceEnv(UA.iphone, 5, true));
    expect(app.where).toContain('홈 화면 앱 전용');
    expect(app.warn).toBeUndefined();
    expect(app.risks.join(' ')).toContain('아이콘을 삭제');
    const tab = storagePlace(deviceEnv(UA.iphone, 5, false));
    expect(tab.warn).toContain('따로 저장');
    expect(tab.risks.join(' ')).toContain('7일');
  });

  it('안드로이드·PC: 사이트 데이터 삭제는 영구 저장이어도 지움', () => {
    expect(storagePlace(deviceEnv(UA.galaxy, 5)).risks[0]).toContain('영구 저장이어도');
    const pc = storagePlace(deviceEnv(UA.edge, 0));
    expect(pc.where).toContain('이 PC Edge');
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

describe('계산 문제 판정(v0.10)', () => {
  it('보기가 숫자 + 지문 숫자, 또는 "구하면·얼마" + 숫자 2개 이상이면 계산 문제', async () => {
    const { looksLikeCalc, isCalcQuestion } = await import('./calc/detect');
    expect(looksLikeCalc('28. 클로소이드의 매개변수 A=60이고, 곡선길이가 40m인 클로소이드 곡선의 반지름은?\n① 60m② 90m\n③ 120m④ 150m')).toBe(true);
    expect(looksLikeCalc('85. 폐합트래버스의 전체 관측선의 총 길이가 2.4km일 때, 폐합비를 1/6000로 제한하기 위한 도상 최대 폐합오차는?\n① 0.1mm ② 0.2mm ③ 0.4mm ④ 0.8mm')).toBe(true);
    expect(looksLikeCalc('13. GNSS의 3가지 구성요소에 해당하지 않는 것은?\n① 우주부문② 사용자부문\n③ 제어(관제)부문④ 장비부문')).toBe(false);
    expect(looksLikeCalc('46. KOMPSAT 중 SAR 영상을 제공하는 위성은?\n① 아리랑 1호 ② 아리랑 3호 ③ 아리랑 5호 ④ 아리랑 3A호')).toBe(false);
    // 전처리기·검수자가 확정한 표시가 우선
    expect(isCalcQuestion({ text: '18. 축척계수는?\n① 0.9996② 0.9999③ 1.0000④ 1.1001', flags: ['no-calc'] })).toBe(false);
    expect(isCalcQuestion({ text: '설명으로 옳은 것은?', flags: ['calc'] })).toBe(true);
  });
});
