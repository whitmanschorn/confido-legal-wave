/**
 * home-signup-link.spec — the "Sign Up Link" connection option on the home page.
 *
 * PLAN.md §6 "home-signup-link.spec". The plan expected the *first* click of
 * `Sign Up For Confido Legal` to record `createFirm`. It does not (QUIRKS #15): the firm is
 * already created before the button is even clickable, because
 * `src/components/home/ConnectionOptionsSplash.tsx:152` renders
 * `<OnboardingFormModal>` unconditionally and
 * `src/components/onboarding-form/OnboardingFormModal.tsx:37-39` fetches an
 * onboarding token from a mount effect, which calls
 * `src/pages/api/onboarding/create-onboarding-code.ts:23` → `createFirm`.
 * The first test below pins that; every click after it takes the
 * `createFirmSignUpLink` branch of `src/pages/api/get-sign-up-link.ts:16`.
 *
 * Frozen contract (PLAN.md §0.1): minted links use the **query** form
 * `${MOCK}/app/signup?s_code=<32 hex>`.
 */

import type { Page } from '@playwright/test';
import {
  MOCK,
  expect,
  getSession,
  signUpCodeFromLink,
  test,
} from '../fixtures/test';
import type { MockEvent } from '../fixtures/test';

const SIGNUP_PREFIX = `${MOCK}/app/signup`;

/** `createFirm(input: { name, mockOnboarding })` as the mock recorded it. */
function createFirmInput(event: MockEvent): { name?: string; mockOnboarding?: boolean } {
  const variables = event.variables as {
    input?: { name?: string; mockOnboarding?: boolean };
  };
  return variables.input ?? {};
}

/**
 * Loads the unconnected home page, waits out the unsolicited
 * `create-onboarding-code` call described above, and opens the `Sign Up Link`
 * accordion panel (only the first panel is expanded by default, and Chakra
 * hides the collapsed ones, so the button is not query-able until then).
 */
async function openSignUpLinkPanel(page: Page): Promise<void> {
  const tokenCall = page.waitForResponse('**/api/onboarding/create-onboarding-code');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Let's get started 🚀" })).toBeVisible();
  await tokenCall;
  await page.getByRole('button', { name: 'Sign Up Link' }).click();
  await expect(page.getByRole('button', { name: 'Sign Up For Confido Legal' })).toBeVisible();
}

test.describe('createFirm', () => {
  test(
    'rendering the unconnected home page creates the Confido firm before any click',
    {
      annotation: {
        type: 'quirk',
        description:
          'QUIRKS #15: ConnectionOptionsSplash.tsx:152 always renders <OnboardingFormModal>, whose mount ' +
          'effect (OnboardingFormModal.tsx:37-39) POSTs /api/onboarding/create-onboarding-code. ' +
          'With no firm token stored, create-onboarding-code.ts:23 calls createFirm and :31 ' +
          'writes the returned apiToken to the local firm. So simply viewing the "not yet ' +
          'connected" page creates a Confido firm and half-connects the account, with no user ' +
          'action — and it happens again on every visit after a Disconnect.',
      },
    },
    async ({ page, context, mock, user }) => {
      const before = await getSession(context.request);
      expect(before.firm?.glApiToken, 'a fresh signup has no firm token').toBeNull();

      const mark = await mock.events.mark();
      const tokenCall = page.waitForResponse('**/api/onboarding/create-onboarding-code');
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: "Let's get started 🚀" }),
      ).toBeVisible();
      await tokenCall;

      const created = await mock.events.waitFor({
        op: 'CreateFirm',
        since: mark,
        where: (event) => createFirmInput(event).name === user.firmName,
      });
      expect(created.ok).toBe(true);
      expect(created.tokenKind).toBe('partner');
      // PLAN.md §0: the app always passes `mockOnboarding: false`.
      expect(createFirmInput(created).mockOnboarding).toBe(false);

      // …and the token was persisted, with no click anywhere.
      const after = await getSession(context.request);
      expect(after.firm?.glApiToken).toMatch(/^f_secret_mock_/);

      const firm = await mock.firms.byToken(after.firm!.glApiToken!);
      expect(firm.name).toBe(user.firmName);
      expect(firm.status).toBe('CREATED');
      expect(firm.isAcceptingPayments).toBe(false);
    },
  );
});

test.describe('Sign Up For Confido Legal', () => {
  test('opens a popup at the mock Confido sign-up link', async ({
    page,
    context,
    mock,
    user,
  }) => {
    await openSignUpLinkPanel(page);

    const mark = await mock.events.mark();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Sign Up For Confido Legal' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();

    // The frozen query form, mirroring the real API (PLAN.md §0.1).
    expect(popup.url().indexOf(`${SIGNUP_PREFIX}?s_code=`)).toBe(0);
    const code = signUpCodeFromLink(popup.url());
    expect(code).toMatch(/^[0-9a-f]{32}$/);

    await expect(
      popup.getByRole('heading', { name: `Mock Confido sign-up for ${user.firmName}` }),
    ).toBeVisible();
    await expect(popup.getByText(code!)).toBeVisible();
    await popup.close();

    // The firm already existed (see the createFirm quirk above), so this click
    // took the `createFirmSignUpLink` branch, authenticated as the firm.
    const session = await getSession(context.request);
    const firmId = (await mock.firms.byToken(session.firm!.glApiToken!)).id;

    const link = await mock.events.waitFor({
      op: 'CreateFirmSignUpLink',
      since: mark,
      firmId,
    });
    expect(link.ok).toBe(true);
    expect(link.tokenKind).toBe('firm');
    // Scoped to this test's own firm name — other workers create firms too.
    expect(
      await mock.events.count({
        op: 'CreateFirm',
        since: mark,
        where: (event) => createFirmInput(event).name === user.firmName,
      }),
    ).toBe(0);
  });

  test('a second click mints another sign-up link, never a second firm', async ({
    page,
    context,
    mock,
    user,
  }) => {
    await openSignUpLinkPanel(page);
    const button = page.getByRole('button', { name: 'Sign Up For Confido Legal' });

    const mark = await mock.events.mark();

    const firstPopupPromise = page.waitForEvent('popup');
    await button.click();
    const firstPopup = await firstPopupPromise;
    await firstPopup.waitForLoadState();
    const firstCode = signUpCodeFromLink(firstPopup.url());
    await firstPopup.close();

    const secondPopupPromise = page.waitForEvent('popup');
    await button.click();
    const secondPopup = await secondPopupPromise;
    await secondPopup.waitForLoadState();
    const secondCode = signUpCodeFromLink(secondPopup.url());
    await secondPopup.close();

    expect(secondPopup.url().indexOf(`${SIGNUP_PREFIX}?s_code=`)).toBe(0);
    expect(secondCode).toMatch(/^[0-9a-f]{32}$/);
    expect(secondCode).not.toBe(firstCode);

    const session = await getSession(context.request);
    const firmId = (await mock.firms.byToken(session.firm!.glApiToken!)).id;

    const links = await mock.events.waitForAll({
      op: 'CreateFirmSignUpLink',
      since: mark,
      firmId,
      count: 2,
    });
    expect(links).toHaveLength(2);

    // Both clicks reused the one firm the page load had already created.
    expect(
      await mock.events.count({
        op: 'CreateFirm',
        since: mark,
        where: (event) => createFirmInput(event).name === user.firmName,
      }),
      'clicking must never create a second firm',
    ).toBe(0);
  });
});

test.describe('a firm that is not accepting payments yet', () => {
  test('the sign-up link the API returns is the frozen query form', async ({
    mock,
    pendingFirmUser,
  }) => {
    expect(pendingFirmUser.signUpLink.indexOf(`${SIGNUP_PREFIX}?s_code=`)).toBe(0);
    expect(pendingFirmUser.signUpCode).toMatch(/^[0-9a-f]{32}$/);

    // …and it is the link the mock minted for THIS firm, not just a well-formed
    // string. Filtered by code, so other workers' links cannot satisfy it.
    const state = await mock.state();
    const minted = state.signUpLinks.filter(
      (record) => record.code === pendingFirmUser.signUpCode,
    );
    expect(minted, 'the s_code must exist in the mock store').toHaveLength(1);
    expect(minted[0].firmId).toBe(pendingFirmUser.firmId);
    expect(minted[0].link).toBe(pendingFirmUser.signUpLink);
  });

  test('home shows Pending, the sandbox hint and no payment vehicles', async ({
    page,
    mock,
    pendingFirmUser,
  }) => {
    const firm = await mock.firms.get(pendingFirmUser.firmId);
    expect(firm.isAcceptingPayments).toBe(false);

    await page.goto('/');
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();

    // `{ exact: true }` — the sentence above the badge contains "pending" too.
    await expect(page.getByText('Pending', { exact: true })).toBeVisible();
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(
        "Your payments application is pending. Once approved you'll be able to collect money!",
      ),
    ).toBeVisible();

    await expect(page.getByRole('button', { name: 'Complete application' })).toBeVisible();
    // The sandbox info alert only renders while the firm is not accepting payments.
    await expect(page.getByRole('link', { name: 'sandbox' })).toBeVisible();
    await expect(
      page.getByText('You can activate the firm using sandbox tools in the'),
    ).toBeVisible();

    // PaymentVehicleSplash is gated on `glFirm.isAcceptingPayments`.
    await expect(
      page.getByRole('heading', { name: "Let's collect some money 💸🤑" }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Try it out' })).toHaveCount(0);
  });

  test('activating the firm flips Pending to Ready on reload', async ({
    page,
    mock,
    pendingFirmUser,
  }) => {
    await page.goto('/');
    await expect(page.getByText('Pending', { exact: true })).toBeVisible();

    const activated = await mock.firms.activate(pendingFirmUser.firmId);
    expect(activated.status).toBe('ACTIVE');
    expect(activated.isAcceptingPayments).toBe(true);

    await page.reload();

    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    await expect(page.getByText('Pending', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText('Your payments application is approved. You are ready to collect money!'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete application' })).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: "Let's collect some money 💸🤑" }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try it out' })).toHaveCount(3);
  });
});
