/**
 * 설치 루트 재설계(v0.15.0, 사용자 2026-11-12 세션 #19) — 모든 시작은 학습앱 설치
 * - 브라우저 화면: 설치 안내만(PC·모바일 탭, 지금 기기 쪽 먼저). 문제팩 가져오기·문제팩 생성기 안내 없음
 * - 설치한 앱의 첫 화면: [문제팩 가져오기]가 메인, 그 아래 서브로 생성기 — PC는 받기 링크, 휴대폰은 안내 문구만(링크 없음)
 * - 옛 생성기 링크(?prep)도 학습앱 설치 안내로
 * - v0.10.1~0.10.3(실기기 Z4·Z5): 데스크톱 모드 안드로이드 태블릿은 Chrome으로, 안드로이드 설치 중 안내
 * - v0.15.1(실기기 2026-11-12): 설치 중 → 완료가 끊김 없이, 안드로이드 파일 고르기 형식 하나, 미설치 브라우저는 기록이 있어도 설치 안내만
 */
import { expect, test } from '@playwright/test';
import { asInstalledApp } from './fixtures';

const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const CHROME_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36';
const FIREFOX_TABLET_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';

test('설치 루트: 브라우저는 설치 안내만(PC·모바일 탭), 설치한 앱의 첫 화면은 문제팩 가져오기 + 생성기 서브(PC만 링크)', async ({ browser }, info) => {
  test.skip(info.project.name !== 'pixel', '한 번만');
  // ① PC 브라우저: 설치 안내만
  // PC는 Chrome 하나로(사용자 2026-11-12 — Edge 설치는 제어판 목록에 안 나옴): Edge로 열면 Chrome으로 옮기라는 안내만
  const edge = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: EDGE });
  const pe = await edge.newPage();
  await pe.goto('./');
  await expect(pe.getByTestId('install-guide')).toContainText('PC에서는 Chrome으로 설치하세요');
  await expect(pe.getByTestId('copy-for-chrome')).toBeVisible();
  await expect(pe.getByTestId('install-guide')).not.toContainText('edge://');
  await edge.close();
  const pc = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: CHROME_PC });
  const p1 = await pc.newPage();
  await p1.goto('./');
  const g1 = p1.getByTestId('install-guide');
  await expect(g1).toContainText('PC에 원큐합격 학습앱 설치');
  await expect(g1).not.toContainText('Edge');
  await expect(g1.getByText('나중에')).toHaveCount(0); // 첫 화면 메인은 숨기기 없음
  await expect(p1.getByTestId('install-tab-pc')).toHaveAttribute('aria-selected', 'true');
  await expect(p1.getByTestId('empty-home')).toHaveCount(0); // 설치 안내에는 문제팩 가져오기 없음
  await expect(p1.getByTestId('maker-sub')).toHaveCount(0); // 생성기 안내도 없음
  await expect(p1.getByText('문제팩 생성기')).toHaveCount(0);
  await p1.getByTestId('install-tab-mobile').click(); // PC에서 휴대폰 설치: QR·주소 복사
  await expect(g1).toContainText('휴대폰·태블릿에 설치하려면');
  await expect(p1.getByTestId('install-qr').locator('svg')).toBeVisible();
  await expect(p1.getByTestId('install-copy-url')).toBeVisible();
  await p1.goto('./?prep'); // 옛 생성기 링크도 학습앱 설치 안내로
  await expect(p1.getByTestId('install-guide')).toContainText('PC에 원큐합격 학습앱 설치');
  await pc.close();

  // ② PC 학습앱(설치한 앱) 첫 실행: 문제팩 가져오기 메인 + 생성기 받기 서브
  const pcApp = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: CHROME_PC });
  await pcApp.addInitScript(asInstalledApp);
  const p2 = await pcApp.newPage();
  await p2.goto('./');
  await expect(p2.getByTestId('install-guide')).toHaveCount(0);
  await expect(p2.getByTestId('empty-home').getByRole('heading')).toHaveText('문제팩 가져오기');
  await expect(p2.getByTestId('empty-home').getByTestId('pack-input')).toHaveCount(1);
  await expect(p2.getByTestId('pack-input')).toHaveAttribute('accept', /application\/zip/);
  const sub = p2.getByTestId('maker-sub');
  await expect(sub).toContainText('문제팩이 없는 경우 원큐합격 문제팩 생성기를 이 PC에 설치하여 문제팩을 만드세요');
  await expect(sub.getByTestId('maker-download')).toHaveAttribute('href', /OneQ-PackMaker-Setup\.exe$/);
  await pcApp.close();

  // ③ 휴대폰 학습앱 첫 실행: 생성기 받기 링크 없이 안내만
  const phoneApp = await browser.newContext({ viewport: { width: 412, height: 915 }, userAgent: ANDROID });
  await phoneApp.addInitScript(asInstalledApp);
  const p3 = await phoneApp.newPage();
  await p3.goto('./');
  await expect(p3.getByTestId('empty-home').getByTestId('pack-input')).toHaveCount(1);
  await expect(p3.getByTestId('pack-input')).toHaveAttribute('accept', '.zip'); // 안드로이드: 형식 하나 → 파일 앱(카메라·사진 선택창 아님)
  await expect(p3.getByTestId('maker-sub')).toContainText('PC에서 원큐합격 학습앱을 설치');
  await expect(p3.getByTestId('maker-download')).toHaveCount(0);
  await expect(p3.locator('a[href*="OneQ-PackMaker"]')).toHaveCount(0);
  await p3.getByRole('button', { name: '백업·설정' }).click(); // 설정에서도 휴대폰에는 링크 없음, 설치 방법은 다른 기기(PC) 탭부터
  await p3.getByTestId('maker-how').locator('summary').click();
  await expect(p3.getByTestId('maker-card-settings')).toContainText('PC에서 원큐합격 학습앱을 설치');
  await expect(p3.locator('a[href*="OneQ-PackMaker"]')).toHaveCount(0);
  await p3.getByTestId('install-how').locator('summary').click();
  await expect(p3.getByTestId('install-guide-settings')).toContainText('PC(Windows)에 설치하려면');
  await phoneApp.close();

  // ④ 데스크톱 모드 안드로이드 태블릿(Firefox) → Chrome으로
  const tab = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: FIREFOX_TABLET_DESKTOP });
  await tab.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }));
  const p4 = await tab.newPage();
  await p4.goto('./');
  await expect(p4.getByTestId('install-guide')).toContainText('이 태블릿에서는 Chrome으로 설치하세요');
  await expect(p4.getByTestId('install-tab-mobile')).toHaveAttribute('aria-selected', 'true');
  await expect(p4.getByTestId('open-chrome')).toBeVisible();
  await tab.close();

  // ⑤ 안드로이드: 설치를 누르면 '설치하고 있어요'(다른 안내가 끼어들지 않음) → 새로 고쳐도 유지. 파일 고르기 형식은 하나(.zip)
  const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, userAgent: ANDROID });
  const p5 = await phone.newPage();
  await p5.goto('./');
  await expect(p5.getByTestId('install-guide')).toContainText('앱으로 설치하세요');
  await expect(p5.getByTestId('install-guide')).toContainText('앱 목록과 홈 화면');
  await expect(p5.getByTestId('empty-home')).toHaveCount(0);
  await p5.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(p5.getByTestId('install-guide')).toContainText('설치하고 있어요');
  await expect(p5.getByTestId('install-guide')).not.toContainText('Chrome');
  await p5.reload();
  await expect(p5.getByTestId('install-guide')).toContainText('설치하고 있어요');
  await phone.close();

  // ⑥ 삼성 인터넷(카카오톡 링크가 기본 브라우저로 열림): Chrome으로 보내지 않고 그 자리에서 설치 안내
  const sam = await browser.newContext({ viewport: { width: 412, height: 915 }, userAgent: SAMSUNG });
  const p6 = await sam.newPage();
  await p6.goto('./');
  await expect(p6.getByTestId('install-guide')).toContainText('현재 페이지 추가');
  await expect(p6.getByTestId('open-chrome')).toHaveCount(0);
  await sam.close();
});
