/**
 * `/iframes/standinglink` — the thin wrapper that embeds a Confido standing
 * link in a full-viewport iframe (PLAN.md §6, `standing-link.spec`).
 *
 * `src/pages/iframes/standinglink.tsx` takes `?url=` straight off the router
 * and drops it into `<Box as='iframe' src={url} … />` with a fixed
 * `title='Confido Legal Standing Link'`; with no `url` it renders the text
 * `No standing link URL provided` instead.
 *
 * The iframe target is the mock server's `/iframe-target` page
 * (`e2e/mock-server/fake-app/pages.ts:106-112`), which is on loopback, so the
 * `lockdown` fixture never sees it.
 */

import { MOCK, expect, test } from '../fixtures/test';

const TARGET_URL = `${MOCK}/iframe-target`;
const IFRAME_TITLE = 'Confido Legal Standing Link';

test.describe('/iframes/standinglink', () => {
  test('embeds the ?url= target in the standing-link iframe', async ({ page }) => {
    await page.goto(`/iframes/standinglink?url=${encodeURIComponent(TARGET_URL)}`);

    const iframe = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute('src', TARGET_URL);

    // Reach into the frame: the mock's page really loaded, it was not just a
    // src attribute on an element that failed to fetch.
    const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
    await expect(frame.getByRole('heading', { name: 'Mock standing link' })).toBeVisible();
    await expect(
      frame.getByText('Mock standing link page rendered by the Confido mock server.'),
    ).toBeVisible();

    await expect(page.getByText('No standing link URL provided')).toHaveCount(0);
  });

  test('keeps the hardening attributes the page sets on the iframe', async ({ page }) => {
    await page.goto(`/iframes/standinglink?url=${encodeURIComponent(TARGET_URL)}`);

    const iframe = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
    // standinglink.tsx:27 — the sandbox allow-list is the only thing standing
    // between an arbitrary `?url=` and the parent page, so pin it.
    await expect(iframe).toHaveAttribute(
      'sandbox',
      'allow-same-origin allow-scripts allow-forms allow-popups allow-top-navigation',
    );
    await expect(iframe).toHaveAttribute('allowfullscreen', '');
  });

  test('shows `No standing link URL provided` when ?url= is missing', async ({ page }) => {
    await page.goto('/iframes/standinglink');

    await expect(page.getByText('No standing link URL provided')).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('an empty ?url= is treated as no url at all', async ({ page }) => {
    await page.goto('/iframes/standinglink?url=');

    await expect(page.getByText('No standing link URL provided')).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
  });
});
