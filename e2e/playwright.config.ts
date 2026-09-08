import { defineConfig } from '@playwright/test';

/**
 * PHASE 0 CONFIG — owned by unit F, extended in Phase 1 with the fixture wiring.
 * See PLAN.md §2.
 */

export const MOCK = 'http://127.0.0.1:7002';
export const APP = 'http://127.0.0.1:7001';

/**
 * The env Legal Wave is built AND started with. NEXT_PUBLIC_* vars are inlined
 * at build time, so the same env must be applied to both commands — which is
 * why build and start share one webServer entry.
 *
 * Real process env beats .env.local in Next, so a stray .env.local on a
 * contributor's machine cannot leak the real sandbox into the suite.
 */
export const appEnv: Record<string, string> = {
  CONFIDO_API_ENDPOINT: `${MOCK}/v2`,
  CONFIDO_PARTNER_TOKEN: 'p_secret_mock_partner',
  NEXT_PUBLIC_CONFIDO_APP_DOMAIN: `${MOCK}/app`,
  NEXT_PUBLIC_CONFIDO_SDK_URL: `${MOCK}/js/hosted-fields.js`,
  NEXT_PUBLIC_CL_ONBOARDING_JS_URL: `${MOCK}/js/onboarding.js`,
  GL_WEBHOOK_SECRET: 'mock-webhook-secret',
  GL_LEGACY_WEBHOOK_SECRET: 'mock-legacy-secret',
};

export default defineConfig({
  testDir: 'specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: APP,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx mock-server/server.ts',
      url: `${MOCK}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run reset-db && npm run build && npm run start',
      cwd: '..',
      env: appEnv,
      url: `${APP}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
