/**
 * v0.10.1~0.10.3 설치 안내(실기기 Z4·Z5): 기기별 첫 화면 카드
 * - 설치 경로 두 갈래(v0.14.0, 사용자 2026-11-12): 학습앱 링크 = 이 기기에 학습앱 설치가 메인(PC도 Chrome·Edge 정식 설치),
 *   전처리기는 접힌 서브 / 전처리기 링크(?prep) = 전처리기 설치가 메인, 학습앱은 서브 링크
 * - 안드로이드 태블릿 Firefox "데스크톱 사이트"(Linux x86_64 + 터치): PC가 아니라 태블릿 → [Chrome으로 열기]
 */
import { expect, test } from '@playwright/test';

const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
const FIREFOX_TABLET_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';

test('설치 안내: 학습앱 링크는 설치가 메인·전처리기는 서브, 전처리기 링크(?prep)는 반대, 데스크톱 모드 안드로이드 태블릿은 Chrome으로', async ({ browser }, info) => {
  test.skip(info.project.name !== 'pixel', '한 번만');
  const pc = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: EDGE });
  const p1 = await pc.newPage();
  await p1.goto('./');
  await expect(p1.getByTestId('install-guide')).toContainText('PC에 원큐합격 학습앱 설치');
  await expect(p1.getByTestId('install-guide').getByText('나중에')).toHaveCount(0); // 첫 화면 메인은 숨기기 없음
  await expect(p1.getByTestId('prep-card')).toBeHidden(); // 전처리기는 접힌 서브
  await p1.getByTestId('prep-sub').locator('summary').click();
  await expect(p1.getByTestId('prep-download')).toHaveAttribute('href', /OneQ-Prep-Setup\.exe$/);
  await expect(p1.getByTestId('empty-home').getByTestId('pack-input')).toHaveCount(1); // 가져오기는 접힌 '설치하지 않고 쓰기'
  await p1.goto('./?prep');
  await expect(p1.getByTestId('prep-card')).toContainText('원큐합격 전처리기 설치');
  await expect(p1.getByTestId('prep-download')).toBeVisible();
  await expect(p1.getByTestId('install-guide')).toHaveCount(0);
  await expect(p1.getByTestId('empty-home')).toHaveCount(0);
  await expect(p1.getByTestId('prep-study-sub').getByRole('link')).toHaveAttribute('href', /\/OneQ-Ace\/$/);
  await pc.close();

  const ph = await browser.newContext({ ...info.project.use });
  const p0 = await ph.newPage();
  await p0.goto('./?prep');
  await expect(p0.getByTestId('prep-card')).toContainText('전처리기는 Windows PC에서 설치합니다');
  await expect(p0.getByTestId('prep-copy-url')).toBeVisible();
  await ph.close();

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
