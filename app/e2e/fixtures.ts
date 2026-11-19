/**
 * 시험용: 설치한 앱(홈 화면·PC 앱 창)으로 연 것처럼 — 설치 루트 재설계(세션 #19) 뒤로 문제팩 가져오기는 설치한 앱에서만 보인다.
 * Playwright는 display-mode를 흉내 낼 수 없어 matchMedia('(display-mode: standalone)')만 '맞음'으로 바꾼다.
 */
import { test as base } from '@playwright/test';

export function asInstalledApp(): void {
  const orig = window.matchMedia.bind(window);
  window.matchMedia = (q: string) => (/display-mode:\s*standalone/.test(q) ? orig('(min-width: 0px)') : orig(q));
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(asInstalledApp);
    await use(context);
  },
});
export { expect } from '@playwright/test';
