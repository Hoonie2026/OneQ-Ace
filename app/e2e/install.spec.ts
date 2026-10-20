/**
 * v0.10.1~0.10.2 설치 안내(실기기 Z4·Z5): 기기별 첫 화면 카드
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
});
