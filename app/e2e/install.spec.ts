/**
 * v0.10.1~0.10.3 설치 안내(실기기 Z4·Z5): 기기별 첫 화면 카드
 * - PC Edge: "PC에 설치" 카드 → 설치되면(appinstalled) 새로 고치지 않아도 카드가 사라짐
 * - 안드로이드 태블릿 Firefox "데스크톱 사이트"(Linux x86_64 + 터치): PC가 아니라 태블릿 → [Chrome으로 열기]
 */
import { expect, test } from '@playwright/test';

const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
const FIREFOX_TABLET_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';

test('설치 안내: PC는 설치 직후 카드가 사라지고, 데스크톱 모드 안드로이드 태블릿은 Chrome으로', async ({ browser }, info) => {
  test.skip(info.project.name !== 'pixel', '한 번만');
  const pc = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: EDGE });
  const p1 = await pc.newPage();
  await p1.goto('./');
  await expect(p1.getByTestId('install-guide')).toContainText('PC에 설치');
  await p1.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(p1.getByTestId('install-guide')).toHaveCount(0);
  await pc.close();

  const tab = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: FIREFOX_TABLET_DESKTOP });
  await tab.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }));
  const p2 = await tab.newPage();
  await p2.goto('./');
  await expect(p2.getByTestId('install-guide')).toContainText('이 태블릿에서는 Chrome으로 설치하세요');
  await expect(p2.getByTestId('open-chrome')).toBeVisible();
  await tab.close();

  // v0.10.3: 안드로이드는 설치를 눌러도 브라우저 화면이 남고 아이콘은 1~2분 뒤 → "설치하고 있습니다 · 이 화면은 브라우저 · 닫고 아이콘으로"(새로 고쳐도 유지)
  const phone = await browser.newContext({
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  });
  const p3 = await phone.newPage();
  await p3.goto('./');
  await expect(p3.getByTestId('install-guide')).toContainText('앱으로 설치하세요');
  await p3.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(p3.getByTestId('install-guide')).toContainText('설치하고 있습니다');
  await expect(p3.getByTestId('install-guide')).toContainText('브라우저 화면을 닫습니다');
  await p3.reload();
  await expect(p3.getByTestId('install-guide')).toContainText('설치하고 있습니다');
  await phone.close();
});
