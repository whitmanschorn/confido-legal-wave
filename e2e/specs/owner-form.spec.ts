/**
 * `/owner-form` — the standalone page Confido's onboarding flow deep-links a
 * beneficial owner into (PLAN.md §6, `owner-form.spec`).
 *
 * The page is not behind `requireAuth` (`src/pages/owner-form.tsx` has no
 * `getServerSideProps`), so none of these tests need a user, a firm or a
 * Confido connection. It reads `o_code` off the query string and hands it to
 * `window.confidoOnboarding.renderOwnerForm({ code, containerId })` in a
 * `useEffect` (`src/pages/owner-form.tsx:11-20`).
 *
 * The onboarding shim (`e2e/shims/onboarding.js:158-172`) answers that call by
 * emptying `#confido-owner-form`, stamping `data-owner-code` on it and
 * appending `<div data-testid="owner-form">Owner form for <code></div>` — so
 * `Owner form for owner_abc` is the shim's output, not the app's.
 */

import { expect, test } from '../fixtures/test';

const OWNER_FORM_CONTAINER = '#confido-owner-form';

test.describe('/owner-form', () => {
  test('renders the onboarding SDK owner form for the o_code in the query string', async ({
    page,
  }) => {
    await page.goto('/owner-form?o_code=owner_abc');

    // The shim's output. Its presence proves the page called
    // window.confidoOnboarding.renderOwnerForm with the query-string code.
    await expect(page.getByTestId('owner-form')).toHaveText('Owner form for owner_abc');
    await expect(page.getByText('Owner form for owner_abc')).toBeVisible();

    // The container the app renders, keyed by the code the shim was handed.
    await expect(page.locator(OWNER_FORM_CONTAINER)).toHaveAttribute(
      'data-owner-code',
      'owner_abc',
    );

    // The error branch (`{!code && <Alert status='error'>Invalid url</Alert>}`)
    // must not render when a code is present.
    await expect(page.getByText('Invalid url')).toHaveCount(0);
  });

  test('passes the o_code through verbatim, whatever it is', async ({ page }) => {
    const code = 'owner_ZY9-x_42';
    await page.goto(`/owner-form?o_code=${code}`);

    await expect(page.getByTestId('owner-form')).toHaveText(`Owner form for ${code}`);
    await expect(page.locator(OWNER_FORM_CONTAINER)).toHaveAttribute('data-owner-code', code);
  });

  test('shows the `Invalid url` alert when there is no o_code', async ({ page }) => {
    await page.goto('/owner-form');

    const alert = page.getByText('Invalid url');
    await expect(alert).toBeVisible();

    // The container is still rendered, but nothing was rendered into it: the
    // effect returns early when `code` is falsy (owner-form.tsx:12-14).
    await expect(page.locator(OWNER_FORM_CONTAINER)).toBeAttached();
    await expect(page.locator(OWNER_FORM_CONTAINER)).toBeEmpty();
    await expect(page.getByTestId('owner-form')).toHaveCount(0);
  });

  test('an empty o_code is treated as no code at all', async ({ page }) => {
    await page.goto('/owner-form?o_code=');

    // `query.o_code` is the empty string, which is falsy, so the app takes the
    // same branch as a missing parameter.
    await expect(page.getByText('Invalid url')).toBeVisible();
    await expect(page.getByTestId('owner-form')).toHaveCount(0);
  });
});
