import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// 클라우드 개발 환경에는 Chromium이 /opt/pw-browsers에 미리 설치돼 있다. PC에서는 `npx playwright install chromium` 후 실행
const preinstalled = '/opt/pw-browsers/chromium';
const launchOptions = existsSync(preinstalled) ? { executablePath: preinstalled } : {};

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/OneQ-Ace/',
    serviceWorkers: 'allow',
    acceptDownloads: true,
    launchOptions,
  },
  projects: [
    { name: 'pixel', use: { ...devices['Pixel 7'] } },
    // WebKit(iOS)은 설치하지 않으므로 iPhone 화면 크기만 Chromium으로 흉내 낸다. 실제 iOS 확인은 실기기(7단계)
    { name: 'iphone-size', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/OneQ-Ace/',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
