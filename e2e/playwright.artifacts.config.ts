import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * "Show me what the tests actually do" configuration.
 *
 * The default config keeps artifacts only on failure, which is right for CI — a
 * green run should be cheap and quiet. This one forces video, a full-page
 * screenshot and a trace for EVERY test, and emits the browsable HTML report,
 * so a passing run becomes something you can watch.
 *
 *   npx playwright test --config playwright.artifacts.config.ts specs/clients.spec.ts
 *   npx playwright show-report artifacts-report
 *
 * Everything else — the two web servers, the fixtures, the mock env — is
 * inherited unchanged from playwright.config.ts, so what you are watching is
 * exactly the suite that runs in CI, not a special-cased rerun.
 *
 * Recording costs real time and disk (roughly a few hundred KB of video per
 * test), which is why it is opt-in rather than the default.
 */
export default defineConfig({
  ...base,
  outputDir: 'artifacts-results',
  // Videos are recorded per worker; fewer workers keeps the machine honest and
  // the recordings smoother.
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'artifacts-report' }]],
  use: {
    ...base.use,
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    screenshot: 'on',
    trace: 'on',
    viewport: { width: 1280, height: 720 },
  },
});
