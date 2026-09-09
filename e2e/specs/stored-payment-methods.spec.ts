/**
 * `/stored-payment-methods` — PLAN.md §6, `stored-payment-methods.spec`.
 *
 * The page is one button (`src/pages/stored-payment-methods.tsx:14`) that opens
 * `CreateStoredPaymentMethodModal`. The modal:
 *
 *   1. mounts `useSavePaymentMethodToken`, which GETs
 *      `/api/stored-payment-methods/create-token` → `createSavePaymentMethodToken`
 *      (`CreateStoredPaymentMethodModal.tsx:43`, `useSavePaymentMethodToken.ts:14-19`);
 *   2. renders `Loading...` until that resolves (`…Modal.tsx:51`);
 *   3. renders the hosted-field form once a `token` exists (`…Modal.tsx:53-59`);
 *   4. on `Save`, calls `window.gravityLegal.submitFields()` and then POSTs
 *      `/api/stored-payment-methods/complete` → `completeSavePaymentMethod`
 *      (`…Modal.tsx:96-136`);
 *   5. replaces the whole body with `Success!`, the raw result JSON and a
 *      `Close` button (`…Modal.tsx:138-153`).
 *
 * Two quirks are pinned here on purpose:
 *   • QUIRKS.md #5 — the token mutation's variables go on the wire malformed.
 *   • A new one — the token hook has no error path at all, so an unconnected
 *     firm gets a silently empty modal. See the last test.
 */

import {
  ACH,
  CARDS,
  expect,
  fillAchFields,
  fillCardFields,
  hostedField,
  savePaymentMethodAndCaptureResponse,
  test,
} from '../fixtures/test';
import type { Locator, Page } from '@playwright/test';

/** The dialog, addressed by its accessible name (Chakra's `ModalHeader`). */
function modal(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Save a Payment Method' });
}

/**
 * The `Close` button in the success body. Distinguished from Chakra's
 * `ModalCloseButton` (`…Modal.tsx:50`), an icon button whose accessible name is
 * also exactly `Close`, by the fact that only this one has visible text.
 */
function successCloseButton(page: Page): Locator {
  return page
    .getByRole('button', { name: 'Close', exact: true })
    .filter({ hasText: 'Close' });
}

/** Opens the modal and waits for the token round-trip to have rendered the form. */
async function openModal(page: Page): Promise<Locator> {
  await page.goto('/stored-payment-methods');
  await page.getByRole('button', { name: 'Save New Payment Method' }).click();
  const dialog = modal(page);
  await expect(dialog).toBeVisible();
  await expect(hostedField(page, 'cardNumber')).toBeAttached();
  return dialog;
}

test.describe('stored payment methods', () => {
  test('opening the modal shows Loading… then the form, and mints a save-payment-method token', async ({
    page,
    mock,
    connectedUser,
  }) => {
    const mark = await mock.events.mark();

    // Hold the token response open so `Loading...` is observable deterministically
    // rather than by racing it. No timeout is involved: the gate is released by
    // the assertion below, not by the clock.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/stored-payment-methods/create-token', async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto('/stored-payment-methods');
    await page.getByRole('button', { name: 'Save New Payment Method' }).click();

    const dialog = modal(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Loading...')).toBeVisible();
    // While loading there is no form and no submit button.
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);

    // Releasing the gate lets the handler fall through to `route.continue()`.
    // (Do not `page.unroute` here — that auto-handles the in-flight route and
    // the handler's own `continue()` then throws "Route is already handled".)
    release();

    await expect(dialog.getByText('Loading...')).toHaveCount(0);
    await expect(dialog.getByLabel('Client name')).toBeVisible();
    await expect(dialog.getByLabel('Email')).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Card' })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Bank Account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(hostedField(page, 'cardNumber')).toBeAttached();
    await expect(hostedField(page, 'cardExpirationDate')).toBeAttached();
    await expect(hostedField(page, 'cardSecurityCode')).toBeAttached();

    const event = await mock.events.waitFor({
      op: 'CreateSavePaymentMethodToken',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(event.ok).toBe(true);
    expect(event.tokenKind).toBe('firm');
  });

  test(
    'the CreateSavePaymentMethodToken request carries a malformed variables payload',
    {
      annotation: {
        type: 'quirk',
        description:
          'QUIRKS.md #5: createSavePaymentMethodToken.ts:34-45 passes an options ' +
          'wrapper `{ variables: { input: … } }` as graphql-request\'s second ' +
          'positional argument, which IS the variables object. The wire payload is ' +
          'therefore `variables: { variables: { input: {} } }`, `$input` is never ' +
          'supplied, and `clientId` can never reach Confido. This assertion failing ' +
          'means someone fixed the bug.',
      },
    },
    async ({ page, mock, connectedUser }) => {
      const mark = await mock.events.mark();
      await openModal(page);

      const event = await mock.events.waitFor({
        op: 'CreateSavePaymentMethodToken',
        firmId: connectedUser.firmId,
        since: mark,
      });

      // The correct payload would be `{ input: {} }`. It is double-wrapped.
      expect(event.variables).toEqual({ variables: { input: {} } });
      expect(event.variables.input).toBeUndefined();
      // …and the call still succeeds, because `$input` is nullable.
      expect(event.ok).toBe(true);
    },
  );

  test('saving a card stores the payment method and shows Success! with lastFour 4242', async ({
    page,
    mock,
    connectedUser,
  }) => {
    const dialog = await openModal(page);
    const mark = await mock.events.mark();

    await dialog.getByLabel('Client name').fill('Ada Lovelace');
    await dialog.getByLabel('Email').fill('ada@example.com');
    await fillCardFields(page, CARDS.visaSuccess);

    const { status, body } = await savePaymentMethodAndCaptureResponse(page, async () => {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ lastFour: CARDS.visaSuccess.lastFour });

    await expect(dialog.getByRole('heading', { name: 'Success!' })).toBeVisible();
    // The result JSON is the `completeSavePaymentMethod` selection set: id + lastFour.
    await expect(dialog).toContainText('"lastFour": "4242"');
    await expect(dialog).toContainText('"id":');
    await expect(successCloseButton(page)).toBeVisible();
    // The form is gone — the success body replaces it entirely.
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);

    const event = await mock.events.waitFor({
      op: 'CompleteSavePaymentMethod',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(event.ok).toBe(true);
    expect(event.variables).toMatchObject({
      input: {
        paymentMethod: 'CREDIT',
        payerName: 'Ada Lovelace',
        payerEmail: 'ada@example.com',
      },
    });

    // `Close` dismisses the modal (`…Modal.tsx:147` → the page's `onClose`).
    await successCloseButton(page).click();
    await expect(dialog).toBeHidden();
  });

  test('saving a bank account stores it as ACH with the account lastFour', async ({
    page,
    mock,
    connectedUser,
  }) => {
    const dialog = await openModal(page);
    const mark = await mock.events.mark();

    await dialog.getByLabel('Client name').fill('Grace Hopper');
    await dialog.getByLabel('Email').fill('grace@example.com');
    await dialog.getByRole('tab', { name: 'Bank Account' }).click();
    await expect(hostedField(page, 'accountNumber')).toBeVisible();
    await fillAchFields(page, ACH.valid);

    const { status, body } = await savePaymentMethodAndCaptureResponse(page, async () => {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ lastFour: ACH.valid.lastFour });

    await expect(dialog.getByRole('heading', { name: 'Success!' })).toBeVisible();
    await expect(dialog).toContainText(`"lastFour": "${ACH.valid.lastFour}"`);
    await expect(successCloseButton(page)).toBeVisible();

    const event = await mock.events.waitFor({
      op: 'CompleteSavePaymentMethod',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(event.ok).toBe(true);
    expect(event.variables).toMatchObject({
      input: {
        paymentMethod: 'ACH',
        payerName: 'Grace Hopper',
        payerEmail: 'grace@example.com',
      },
    });
  });

  test('submitting with empty fields shows the shim validation error and calls nothing', async ({
    page,
    mock,
    connectedUser,
  }) => {
    const dialog = await openModal(page);
    const mark = await mock.events.mark();

    // `useForm` registers no validation rules (`…Modal.tsx:163`, `:168`), so the
    // react-hook-form "valid" branch always runs; the guard that actually fires
    // is the shim's `submitFields()`, whose `{ error }` lands in `setError`
    // (`…Modal.tsx:100-107`) and renders at `…Modal.tsx:159`.
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(dialog.getByText('Invalid fields')).toBeVisible();
    await expect(dialog.getByText('Required')).toHaveCount(3);
    await expect(dialog.getByRole('heading', { name: 'Success!' })).toHaveCount(0);

    // No API call was made. Asserted through the event log, not a timeout: the
    // `Invalid fields` message above already proves the round-trip finished.
    // (`GetFirm` is excluded — `SessionProvider`'s `/api/session` fetch can
    // still land here and has nothing to do with the form.)
    const events = await mock.events.list({ since: mark, firmId: connectedUser.firmId });
    expect(
      events
        .map((event) => event.operationName)
        .filter((name) => name !== 'GetFirm'),
      'submitFields() rejected locally, so nothing should have reached Confido',
    ).toHaveLength(0);

    // The form is still there and still usable.
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  });

  test('Cancel closes the modal without saving anything', async ({
    page,
    mock,
    connectedUser,
  }) => {
    const dialog = await openModal(page);
    const mark = await mock.events.mark();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    const events = await mock.events.list({ since: mark, firmId: connectedUser.firmId });
    expect(
      events
        .map((event) => event.operationName)
        .filter((name) => name !== 'GetFirm'),
    ).toHaveLength(0);
  });

  test(
    'an unconnected firm gets a silently empty modal: no form, no error, no explanation',
    {
      annotation: {
        type: 'quirk',
        description:
          'useSavePaymentMethodToken (src/components/stored-payment-methods/' +
          'useSavePaymentMethodToken.ts:14-19) has no catch and never checks ' +
          '`result.ok`. For a firm with no glApiToken, /api/stored-payment-methods/' +
          'create-token returns HTTP 500 with `{error}` (create-token.ts:18-21); the ' +
          'hook JSON-parses that body, does setToken(undefined) and setLoading(false), ' +
          'and `error` (declared at :12) is never assigned. So the modal drops out of ' +
          'the `loading` branch (…Modal.tsx:51) but matches neither the `error` ' +
          'branch (:52) nor the `token` branch (:53): the user is left with a dialog ' +
          'containing only its header and close button, and no way to know why.',
      },
    },
    async ({ page, user }) => {
      // `user`, not `connectedUser`: signed in, but the firm has no Confido token.
      expect(user.username).toBeTruthy();

      await page.goto('/stored-payment-methods');
      const waiter = page.waitForResponse(
        '**/api/stored-payment-methods/create-token',
      );
      await page.getByRole('button', { name: 'Save New Payment Method' }).click();

      const dialog = modal(page);
      await expect(dialog).toBeVisible();

      const response = await waiter;
      expect(response.status()).toBe(500);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('Context creation failed: Invalid firm token.'),
      });

      // The loading state does end — the hook is not stuck…
      await expect(dialog.getByText('Loading...')).toHaveCount(0);
      // …but nothing replaces it. The dialog's entire text is its own title.
      await expect(dialog).toHaveText('Save a Payment Method');
      await expect(dialog.getByLabel('Client name')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      await expect(hostedField(page, 'cardNumber')).toHaveCount(0);
      // No error is surfaced anywhere on the page either. (`role="alert"` alone
      // is not usable here: Next always renders `#__next-route-announcer__`
      // with that role, so this looks for a rendered Chakra `<Alert>` instead.)
      await expect(page.locator('.chakra-alert')).toHaveCount(0);
      await expect(page.getByText('Invalid firm token')).toHaveCount(0);

      // Only the header and Chakra's icon-only close button remain.
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1);
      await expect(successCloseButton(page)).toHaveCount(0);
    },
  );

  test(
    'the failed token call still reaches Confido with the malformed variables and an invalid key',
    {
      annotation: {
        type: 'quirk',
        description:
          'Companion to the test above: the unconnected request is not short-circuited ' +
          'anywhere. create-token.ts:11 casts a null `glApiToken` to string and sends it ' +
          'as x-api-key, so the mock (like the real sandbox) answers HTTP 500 ' +
          '"Context creation failed: Invalid firm token." — and the payload it rejects ' +
          'is still the double-wrapped one from QUIRKS.md #5.',
      },
    },
    async ({ page, mock, user }) => {
      expect(user.username).toBeTruthy();
      const mark = await mock.events.mark();

      await page.goto('/stored-payment-methods');
      const waiter = page.waitForResponse(
        '**/api/stored-payment-methods/create-token',
      );
      await page.getByRole('button', { name: 'Save New Payment Method' }).click();
      await expect(modal(page)).toBeVisible();
      await waiter;

      // The firm is unauthenticated, so the event carries no firmId to scope by;
      // `waitFor` is an at-least-one match, which keeps this parallel-safe.
      const event = await mock.events.waitFor({
        op: 'CreateSavePaymentMethodToken',
        since: mark,
        where: (candidate) => candidate.ok === false,
      });
      expect(event.tokenKind).toBe('unknown');
      expect(event.firmId).toBeNull();
      expect(event.errorMessage).toBe('Context creation failed: Invalid firm token.');
      expect(event.variables).toEqual({ variables: { input: {} } });
    },
  );
});
