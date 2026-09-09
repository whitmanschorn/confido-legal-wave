/**
 * home-connect.spec — the Connect (OAuth-ish) flow on the home page.
 *
 * PLAN.md §6 "home-connect.spec". Quirks pinned here:
 *
 *  - QUIRKS #10: `src/pages/index.tsx:13` builds the connect URL with no
 *    `state` query parameter at all, even though
 *    `src/pages/api/gravity-callback.ts:15` reads one back out.
 *  - QUIRKS #11: `src/pages/api/gravity-callback.ts:20` has no try/catch, so
 *    replaying a one-time connect code is an unhandled 500.
 *  - QUIRKS #15: merely rendering the unconnected home page calls
 *    `POST /api/onboarding/create-onboarding-code`, which calls `createFirm` —
 *    the disconnected state re-creates a Confido firm by itself. Pinned in
 *    home-signup-link.spec; here it only has to be waited out so the Connect
 *    callback's write is not raced by it. It is also why nothing in this file
 *    may assert "no Confido call happened" on a home-page load.
 */

import type { Page } from '@playwright/test';
import {
  MOCK,
  connectViaCallback,
  expect,
  getSession,
  test,
} from '../fixtures/test';

/** `src/pages/index.tsx:13` — `${NEXT_PUBLIC_CONFIDO_APP_DOMAIN}/connect/${partner.appId}`. */
const CONNECT_URL = `${MOCK}/app/connect/mock-app`;

/** The three vehicle cards of `src/components/home/PaymentVehiclesSplash.tsx:12-34`. */
const VEHICLES = [
  { name: 'Payment Intents', href: '/payment-intents' },
  { name: 'Stored Payment Methods', href: '/stored-payment-methods' },
  { name: 'Payment Links', href: '/paylinks' },
];

/**
 * Loads the unconnected home page and waits for the onboarding modal's
 * unsolicited `create-onboarding-code` call to finish, so the `prisma.firm`
 * write it performs can never land after the Connect callback's write.
 */
async function gotoUnconnectedHome(page: Page): Promise<void> {
  const tokenCall = page.waitForResponse('**/api/onboarding/create-onboarding-code');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Let's get started 🚀" })).toBeVisible();
  await tokenCall;
}

/** `glFirm.id.slice(0, 6) + '...' + glFirm.id.slice(-6)`. */
function truncateFirmId(firmId: string): string {
  return `${firmId.slice(0, 6)}...${firmId.slice(-6)}`;
}

/**
 * The `Let's collect some money` panel: exactly three cards, each with one
 * `Try it out` link pointing at its own route. Scoped to the splash `section`
 * so the sidebar's links to the same routes can never satisfy it.
 */
async function expectVehicleCards(page: Page): Promise<void> {
  const splash = page
    .locator('section')
    .filter({ hasText: "Let's collect some money" })
    .last();
  await expect(splash.getByRole('link', { name: 'Try it out' })).toHaveCount(3);

  for (let i = 0; i < VEHICLES.length; i += 1) {
    const vehicle = VEHICLES[i];
    const link = splash.locator(`a[href="${vehicle.href}"]`);
    await expect(link, `${vehicle.name} → ${vehicle.href}`).toHaveCount(1);
    await expect(link).toHaveText('Try it out');
    // The link's parent is the card `Stack`, which carries the vehicle name.
    await expect(link.locator('xpath=..')).toContainText(vehicle.name);
  }
}

test.describe('unconnected home', () => {
  test('offers the three connection options and links straight to the Connect page', async ({
    page,
    user,
  }) => {
    await gotoUnconnectedHome(page);
    // The sidebar identifies the logged-in user this splash belongs to.
    await expect(page.getByText(user.username, { exact: true })).toBeVisible();

    // The three accordion headers. Each one's accessible name is the heading
    // text plus its `Badge`, so the badge is asserted for free.
    await expect(
      page.getByRole('button', { name: 'Connect Existing Confido Legal accounts' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sign Up Link New Confido Legal accounts' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Onboarding.js New accounts, apply here!' }),
    ).toBeVisible();

    // Only the first panel is expanded by default (`defaultIndex={0}`), so the
    // Connect link is the one visible call to action.
    const connectLink = page.getByRole('link', { name: new RegExp('connect/mock-app') });
    await expect(connectLink).toHaveCount(1);
    await expect(connectLink).toHaveAttribute('href', CONNECT_URL);
    await expect(connectLink).toHaveAttribute('target', '_blank');
    // The link renders its own URL as its text.
    await expect(connectLink).toContainText(CONNECT_URL);
  });

  test(
    'the Connect URL carries no `state` parameter',
    {
      annotation: {
        type: 'quirk',
        description:
          'QUIRKS #10: src/pages/index.tsx:13 builds the connect URL without a `state` query ' +
          'parameter, while src/pages/api/gravity-callback.ts:15 reads `query.state` back out ' +
          'and logs it. Nothing generates, stores or verifies the CSRF state.',
      },
    },
    async ({ page, user }) => {
      await gotoUnconnectedHome(page);
      await expect(page.getByText(user.username, { exact: true })).toBeVisible();

      const href = await page
        .getByRole('link', { name: new RegExp('connect/mock-app') })
        .getAttribute('href');
      expect(href).toBe(CONNECT_URL);

      const url = new URL(href!);
      expect(url.search).toBe('');
      expect(url.searchParams.get('state')).toBeNull();
    },
  );
});

test.describe('connecting', () => {
  test('Connect → Authorize in the popup → home shows the connected firm', async ({
    page,
    context,
    mock,
    user,
  }) => {
    await gotoUnconnectedHome(page);
    await expect(page.getByText(user.username, { exact: true })).toBeVisible();

    const mark = await mock.events.mark();

    // `isExternal` renders target=_blank, so the authorize screen is a popup.
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: new RegExp('connect/mock-app') }).click();
    const popup = await popupPromise;

    await expect(popup).toHaveURL(CONNECT_URL);
    await expect(popup.getByRole('heading', { name: 'Authorize Legal Wave' })).toBeVisible();

    // Authorizing mints an ACTIVE firm + one-time code and redirects the popup
    // through `/api/gravity-callback`, which 303s to `/`.
    await popup.getByRole('button', { name: 'Authorize' }).click();
    await popup.waitForURL((url) => url.pathname === '/');

    const exchange = await mock.events.waitFor({
      op: 'ExchangedCodeForFirmToken',
      since: mark,
    });
    expect(exchange.ok).toBe(true);
    expect(exchange.tokenKind).toBe('partner');
    await popup.close();

    // The opener is not refreshed by the flow; the user reloads it.
    await page.reload();
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();

    const session = await getSession(context.request);
    const firmId = session.glFirm?.id;
    expect(firmId, 'the callback must have stored a Confido firm token').toBeTruthy();
    expect(session.firm?.glApiToken).toMatch(/^f_secret_mock_/);
    expect(session.glFirm?.isAcceptingPayments).toBe(true);

    const firm = await mock.firms.get(firmId!);
    expect(session.glFirm?.name).toBe(firm.name);
    expect(firm.status).toBe('ACTIVE');
    expect(firm.isAcceptingPayments).toBe(true);
    expect(firm.name).toMatch(/^Connected Firm /);

    // Firm name and truncated id, exactly as GravityLegalConnectStatus renders
    // them: `<strong>{glFirm.name}</strong> {truncatedFirmId()}` in one <Text>.
    await expect(page.getByText(firm.name, { exact: true })).toBeVisible();
    await expect(page.getByText(truncateFirmId(firmId!))).toHaveText(
      `${firm.name} ${truncateFirmId(firmId!)}`,
    );

    // `{ exact: true }` — the sentence above the badge also contains "Ready".
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Your payments application is approved. You are ready to collect money!'),
    ).toBeVisible();
    await expect(page.getByText('Pending', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Complete application' })).toHaveCount(0);

    await expect(
      page.getByRole('heading', { name: "Let's collect some money 💸🤑" }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();

    // …and the three vehicle cards the connected home page unlocks.
    await expectVehicleCards(page);

    // The splash the user started on is gone.
    await expect(
      page.getByRole('heading', { name: "Let's get started 🚀" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: new RegExp('connect/mock-app') }),
    ).toHaveCount(0);
  });

  test('the truncated firm id is the first six and last six characters', async ({
    page,
    connectedUser,
  }) => {
    await page.goto('/');
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();

    const expected = truncateFirmId(connectedUser.firmId);
    expect(expected).toHaveLength(15);
    expect(expected.slice(6, 9)).toBe('...');
    await expect(page.getByText(expected)).toHaveText(
      `${connectedUser.confidoFirmName} ${expected}`,
    );
    // The full id is never shown.
    await expect(page.getByText(connectedUser.firmId)).toHaveCount(0);
  });

  test('the three payment-vehicle cards link to their routes', async ({
    page,
    connectedUser,
  }) => {
    await page.goto('/');
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();
    // The sidebar identifies the firm this page belongs to.
    await expect(page.getByText(connectedUser.username, { exact: true })).toBeVisible();

    await expectVehicleCards(page);
  });
});

test.describe('disconnecting', () => {
  test('Disconnect revokes the firm token and brings the splash back', async ({
    page,
    mock,
    connectedUser,
  }) => {
    await page.goto('/');
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();

    const mark = await mock.events.mark();

    // The button reloads the page itself; capture the session that reload reads
    // so the assertion cannot be raced by the create-onboarding-code call that
    // the freshly rendered splash fires (see the file header).
    const sessionAfterReload = page.waitForResponse(
      (response) =>
        response.url().indexOf('/api/session') !== -1 &&
        response.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Disconnect' }).click();

    await expect(page.getByRole('heading', { name: "Let's get started 🚀" })).toBeVisible();
    await expect(page.getByText('Connected to Confido Legal ✅')).toHaveCount(0);

    const disconnect = await mock.events.waitFor({
      op: 'DisconnectFromPartner',
      since: mark,
      firmId: connectedUser.firmId,
    });
    expect(disconnect.ok).toBe(true);

    const body = (await (await sessionAfterReload).json()) as {
      firm?: { glApiToken: string | null };
      glFirm?: unknown;
    };
    expect(body.firm?.glApiToken).toBeNull();
    expect(body.glFirm).toBeUndefined();

    // `disconnectFromPartner` revokes the calling token immediately (PLAN §0.1).
    const firm = await mock.firms.get(connectedUser.firmId);
    expect(firm.revokedTokens).toContain(connectedUser.firmToken);
  });
});

test.describe('replaying a connect code', () => {
  test(
    'reusing a one-time connect code 500s',
    {
      annotation: {
        type: 'quirk',
        description:
          'QUIRKS #11: src/pages/api/gravity-callback.ts:20 calls exchangeCodeForFirmToken ' +
          'with no try/catch, so replaying the callback URL (a browser back button is enough) ' +
          'throws unhandled and Next answers a bare 500 "Internal Server Error".',
      },
    },
    async ({ page, context, mock, connectedUser }) => {
      // Scoped to this test's own code: three other workers are replaying and
      // exchanging codes against the same mock store at the same time.
      const mark = await mock.events.mark();

      // The fixture already exchanged this code once.
      const response = await connectViaCallback(page, connectedUser.connectCode);

      expect(response, 'no response from /api/gravity-callback').not.toBeNull();
      expect(response!.status()).toBe(500);
      await expect(page.getByText('Internal Server Error')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/api/gravity-callback');

      // The mock rejected the second exchange, and the stored token is untouched.
      const failed = await mock.events.waitFor({
        op: 'ExchangedCodeForFirmToken',
        since: mark,
        where: (event) =>
          (event.variables as { code?: string }).code === connectedUser.connectCode,
      });
      expect(failed.ok).toBe(false);
      expect(failed.errorMessage).toBe('Invalid or expired code');

      const session = await getSession(context.request);
      expect(session.firm?.glApiToken).toBe(connectedUser.firmToken);
      // The replay took nothing away either: the firm is still connected.
      expect(session.glFirm?.id).toBe(connectedUser.firmId);
    },
  );
});
