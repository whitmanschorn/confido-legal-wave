/**
 * home-onboarding.spec — the Onboarding.js modal on the home page.
 *
 * PLAN.md §6 "home-onboarding.spec". The modal is
 * `src/components/onboarding-form/OnboardingFormModal.tsx`; the form inside it
 * is rendered by `e2e/shims/onboarding.js` (`window.confidoOnboarding.renderForm`),
 * which renders `Legal business name`, `EIN` and a `Submit application` button,
 * and on submit POSTs `/__control/onboarding/:token/submit` and swaps the form
 * for the text `Application submitted`.
 *
 * Note the token is fetched from a **mount effect** (QUIRKS #15), not the click:
 * `OnboardingFormModal.tsx:37-39` runs `fetchToken()` on mount and the modal is
 * rendered unconditionally by both home states, so `createFirm` /
 * `createOnboardingToken` are already on the wire before `Apply Now!` or
 * `Complete application` is clicked. Both tests below take their event mark
 * before the navigation for that reason.
 */

import type { Page } from '@playwright/test';
import { expect, getSession, test } from '../fixtures/test';

/** The shim's form (`e2e/shims/onboarding.js`). */
async function expectOnboardingForm(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Legal business name')).toBeVisible();
  await expect(dialog.getByLabel('EIN')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Submit application' })).toBeVisible();
}

test.describe('Apply Now! on the unconnected home page', () => {
  test('opens the onboarding form, submits it, and the firm reaches APP_SUBMITTED', async ({
    page,
    context,
    mock,
    user,
  }) => {
    const mark = await mock.events.mark();

    const tokenCall = page.waitForResponse('**/api/onboarding/create-onboarding-code');
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: "Let's get started 🚀" }),
    ).toBeVisible();
    const tokenResponse = await tokenCall;
    const token = ((await tokenResponse.json()) as { token: string }).token;
    expect(token).toMatch(/^onboarding_public_mock_/);

    // The firm this token belongs to — created by the same request.
    const session = await getSession(context.request);
    expect(session.firm?.glApiToken).toMatch(/^f_secret_mock_/);
    const firm = await mock.firms.byToken(session.firm!.glApiToken!);
    expect(firm.name).toBe(user.firmName);
    expect(firm.status).toBe('CREATED');

    const created = await mock.events.waitFor({
      op: 'CreateFirm',
      since: mark,
      where: (event) => {
        const variables = event.variables as { input?: { name?: string } };
        return (variables.input ?? {}).name === user.firmName;
      },
    });
    expect(created.ok).toBe(true);

    // Chakra hides collapsed accordion panels, so the panel must be opened first.
    await page.getByRole('button', { name: 'Onboarding.js' }).click();
    await page.getByRole('button', { name: 'Apply Now!' }).click();

    await expectOnboardingForm(page);

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Legal business name').fill(`${user.firmName} LLC`);
    await dialog.getByLabel('EIN').fill('12-3456789');
    await dialog.getByRole('button', { name: 'Submit application' }).click();

    await expect(dialog.getByText('Application submitted')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Submit application' }),
    ).toHaveCount(0);

    const submitted = await mock.firms.waitForStatus(firm.id, 'APP_SUBMITTED');
    expect(submitted.status).toBe('APP_SUBMITTED');
    // Submitting the application does not make the firm live.
    expect(submitted.isAcceptingPayments).toBe(false);

    // PLAN.md §6 asks for the status in `/__control/state`; scoped to our own
    // firm id, since every worker's firms are in the same dump.
    const state = await mock.state();
    const inState = state.firms.filter((record) => record.id === firm.id);
    expect(inState, 'our firm must be in /__control/state').toHaveLength(1);
    expect(inState[0].status).toBe('APP_SUBMITTED');
    expect(inState[0].name).toBe(user.firmName);
    // And the onboarding token the shim submitted belongs to it.
    const tokens = state.onboardingTokens.filter((record) => record.token === token);
    expect(tokens, 'the onboarding token must be in the store').toHaveLength(1);
    expect(tokens[0].firmId).toBe(firm.id);

    // Closing calls `router.reload()` (ConnectionOptionsSplash.tsx:29-32); the
    // firm token is stored now, so the connected — but Pending — card renders.
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();
    await expect(page.getByText('Pending', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete application' })).toBeVisible();
  });
});

test.describe('Complete application on a pending firm', () => {
  test(
    'opens the same modal, backed by a createOnboardingToken call',
    {
      annotation: {
        type: 'quirk',
        description:
          'QUIRKS #15: the onboarding token is requested from OnboardingFormModal.tsx:37-39, a mount ' +
          'effect, and GravityLegalConnectStatus.tsx renders the modal unconditionally — so ' +
          '`createOnboardingToken` is issued on every home-page load, whether or not the user ' +
          'ever clicks `Complete application`.',
      },
    },
    async ({ page, mock, pendingFirmUser }) => {
      const mark = await mock.events.mark();

      const tokenCall = page.waitForResponse('**/api/onboarding/create-onboarding-code');
      await page.goto('/');
      await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();
      const tokenResponse = await tokenCall;
      const token = ((await tokenResponse.json()) as { token: string }).token;
      expect(token).toMatch(/^onboarding_public_mock_/);

      // Recorded before the click, as the annotation says.
      const issued = await mock.events.waitFor({
        op: 'CreateOnboardingToken',
        since: mark,
        firmId: pendingFirmUser.firmId,
      });
      expect(issued.ok).toBe(true);
      expect(issued.tokenKind).toBe('firm');

      await page.getByRole('button', { name: 'Complete application' }).click();
      await expectOnboardingForm(page);

      // It is the same shim form, wired to the same token.
      await expect(page.locator('#confido-onboarding-form')).toHaveAttribute(
        'data-onboarding-token',
        token,
      );

      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Legal business name').fill(`${pendingFirmUser.firmName} LLC`);
      await dialog.getByRole('button', { name: 'Submit application' }).click();
      await expect(dialog.getByText('Application submitted')).toBeVisible();

      const submitted = await mock.firms.waitForStatus(
        pendingFirmUser.firmId,
        'APP_SUBMITTED',
      );
      expect(submitted.status).toBe('APP_SUBMITTED');
    },
  );

  test('the modal closes again without changing the connection state', async ({
    page,
    mock,
    pendingFirmUser,
  }) => {
    await page.goto('/');
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();

    await page.getByRole('button', { name: 'Complete application' }).click();
    await expectOnboardingForm(page);

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // GravityLegalConnectStatus's onClose does not reload, so the card stays.
    await expect(page.getByText('Connected to Confido Legal ✅')).toBeVisible();
    await expect(page.getByText('Pending', { exact: true })).toBeVisible();

    const firm = await mock.firms.get(pendingFirmUser.firmId);
    expect(firm.status).toBe('CREATED');
    expect(firm.isAcceptingPayments).toBe(false);
  });
});
