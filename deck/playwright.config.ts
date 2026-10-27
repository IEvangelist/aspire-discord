import { defineConfig } from '@playwright/test';

const basePath = '/aspire-discord/';
// DECK_PORT and DECK_OUT_DIR let parallel local runs use private ports and build folders.
const port = Number(process.env.DECK_PORT ?? 4173);
const outDir = process.env.DECK_OUT_DIR ?? 'dist';
const localUrl = `http://127.0.0.1:${port}${basePath}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.DECK_URL ?? localUrl,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-light', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' } },
  ],
  webServer: process.env.DECK_URL ? undefined : {
    command: `node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort --outDir ${outDir}`,
    url: localUrl,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
