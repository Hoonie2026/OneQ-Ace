/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// GitHub Pages 주소: https://<사용자>.github.io/OneQ-Ace/
const BASE = '/OneQ-Ace/';

export default defineConfig({
  base: BASE,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // e2e/는 Playwright 전용(npm run e2e)
  test: { include: ['src/**/*.test.ts'] },
  plugins: [
    react(),
    VitePWA({
      // 풀이 중 강제 새로고침 금지(개발기준서 9.3) → 사용자가 배너를 눌러 업데이트
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: BASE,
        name: '원큐합격',
        short_name: '원큐합격',
        description: '기사·산업기사 필기 기출 학습앱',
        lang: 'ko',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'any',
        // 이 기기에 앱이 설치됐는지 브라우저 화면에서 알기 위해(getInstalledRelatedApps, 안드로이드 Chrome — v0.10.3)
        related_applications: [{ platform: 'webapp', url: `https://hoonie2026.github.io${BASE}manifest.webmanifest` }],
        background_color: '#0f1d2e',
        theme_color: '#0f1d2e',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        // 글꼴(Pretendard, v0.9.0)은 미리 다 받지 않고 쓰는 글자 묶음만 받아 두고 이후 오프라인으로
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.woff2'),
            handler: 'CacheFirst',
            options: { cacheName: 'oneq-fonts', expiration: { maxEntries: 120 } },
          },
        ],
      },
    }),
  ],
});
