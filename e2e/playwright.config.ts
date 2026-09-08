import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration — owned by unit F. See PLAN.md §2.
 *
 * Two web servers are started, both bound to 127.0.0.1 (never `localhost`, so
 * the lockdown fixture's origin allow-list is exact and IPv6 resolution can
 * never surprise us):
 *
 *   7002  the mock Confido API (GraphQL at /v2, control API at /__control,
 *         shims at /js, fake Confido app pages at /app)
 *   7001  Legal Wave itself, BUILT and STARTED with the mock env
 *
 * Nothing in here, and nothing in the whole suite, contains a real credential.
 * The only token literal permitted in this repo is `p_secret_mock_partner`.
 */

export const MOCK = 'http://127.0.0.1:7002';
export const APP = 'http://127.0.0.1:7001';

/** The mock's GraphQL endpoint — where browser-side Confido calls get forwarded. */
export const MOCK_GRAPHQL_URL = `${MOCK}/v2`;

/**
 * The sandbox URL that `src/confido-legal-requests/index.ts` inlines into the
 * client bundle as its fallback. The Clients page talks to it straight from the
 * browser, so the `lockdown` fixture forwards this one origin to the mock
 * instead of aborting it. It is never actually contacted.
 */
export const SANDBOX_GRAPHQL_URL = 'https://api.sandbox.gravity-legal.com/v2';

/** The one and only token literal in the repo (PLAN.md §8.2). */
export const PARTNER_TOKEN = 'p_secret_mock_partner';

export const WEBHOOK_SECRET = 'mock-webhook-secret';
export const LEGACY_WEBHOOK_SECRET = 'mock-legacy-secret';

/**
 * The env Legal Wave is built AND started with. NEXT_PUBLIC_* vars are inlined
 * at build time, so the same env must be applied to both commands — which is
 * why build and start share one webServer entry.
 *
 * Playwright merges this over `process.env` for the spawned process, and real
 * process env beats `.env.local` in Next, so a stray `.env.local` on a
 * contributor's machine cannot leak the real sandbox into the suite.
 */
export const appEnv: Record<string, string> = {
  CONFIDO_API_ENDPOINT: MOCK_GRAPHQL_URL,
  CONFIDO_PARTNER_TOKEN: PARTNER_TOKEN,
  NEXT_PUBLIC_CONFIDO_APP_DOMAIN: `${MOCK}/app`,
  NEXT_PUBLIC_CONFIDO_SDK_URL: `${MOCK}/js/hosted-fields.js`,
  NEXT_PUBLIC_CL_ONBOARDING_JS_URL: `${MOCK}/js/onboarding.js`,
  GL_WEBHOOK_SECRET: WEBHOOK_SECRET,
  GL_LEGACY_WEBHOOK_SECRET: LEGACY_WEBHOOK_SECRET,
};

export default defineConfig({
  testDir: 'specs',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // SQLite + a single Prisma process: three workers is the measured safe point.
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: APP,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The app registers no service worker; blocking them keeps every request
    // visible to the lockdown fixture's route handler.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
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
