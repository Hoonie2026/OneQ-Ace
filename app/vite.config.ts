import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages 주소: https://<사용자>.github.io/OneQ-Ace/
const BASE = '/OneQ-Ace/';

export default defineConfig({
  base: BASE,
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
      },
    }),
  ],
});
