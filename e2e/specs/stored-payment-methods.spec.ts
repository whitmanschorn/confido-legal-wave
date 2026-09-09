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
 * Note that step 1 happens on **page mount**, not on modal open: the page
 * renders `<CreateStoredPaymentMethodModal>` unconditionally
 * (`stored-payment-methods.tsx:16`) and the hook's `useEffect` has an empty
 * dependency array. Two tests below pin that and its consequence.
 *
 * Quirks pinned here on purpose:
 *   • QUIRKS.md #5 — the token mutation's variables go on the wire malformed.
 *   • QUIRKS.md #14 — the token hook has no error path at all, so an
 *     unconnected firm gets a silently empty modal. See the last two tests.
 *   • Not yet in QUIRKS.md — visiting the route mints a Confido save-payment-
 *     method token with no user action, once per page load, so reopening the
 *     modal after a successful save hands the user a live-looking form bound to
 *     a token Confido has already consumed.
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
    const saved = body as { id: string; lastFour: string };
    expect(saved.id).not.toHaveLength(0);

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

    // End of the line: the record the mock persisted, scoped to this firm (never
    // to a global count — three other workers are storing methods too).
    const state = await mock.state();
    const mine = state.spms.filter((spm) => spm.firmId === connectedUser.firmId);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(saved.id);
    expect(mine[0]).toMatchObject({
      lastFour: CARDS.visaSuccess.lastFour,
      paymentMethod: 'CREDIT',
      cardBrand: CARDS.visaSuccess.brand,
      payerName: 'Ada Lovelace',
      payerEmail: 'ada@example.com',
    });
    // The one-time session it consumed is now marked used.
    const spmSessions = state.sessions.filter(
      (session) => session.firmId === connectedUser.firmId && session.kind === 'spm',
    );
    expect(spmSessions).toHaveLength(1);
    expect(spmSessions[0].used).toBe(true);

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
    const saved = body as { id: string; lastFour: string };

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

    // ACH end-to-end: the shim staged an `ach` form, the browser sent
    // `paymentMethod: 'ACH'` (asserted above), and the record the mock stored for
    // THIS firm says ACH as well — with no card brand, unlike the card variant.
    const state = await mock.state();
    const mine = state.spms.filter((spm) => spm.firmId === connectedUser.firmId);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(saved.id);
    expect(mine[0]).toMatchObject({
      lastFour: ACH.valid.lastFour,
      paymentMethod: 'ACH',
      cardBrand: null,
      payerName: 'Grace Hopper',
      payerEmail: 'grace@example.com',
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

  test('the header close button discards the form without saving anything', async ({
    page,
    mock,
    connectedUser,
  }) => {
    const dialog = await openModal(page);
    const mark = await mock.events.mark();

    await dialog.getByLabel('Client name').fill('Never Saved');
    await dialog.getByLabel('Email').fill('never@example.com');
    await fillCardFields(page, CARDS.visaSuccess);

    // Chakra's icon-only `ModalCloseButton` (`…Modal.tsx:50`). While the form is
    // showing, the success `Close` button does not exist, so this is unambiguous.
    await expect(successCloseButton(page)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    const events = await mock.events.list({ since: mark, firmId: connectedUser.firmId });
    expect(
      events
        .map((event) => event.operationName)
        .filter((name) => name !== 'GetFirm'),
    ).toHaveLength(0);

    // Nothing was stored for this firm, and the minted session is still unused.
    const state = await mock.state();
    expect(state.spms.filter((spm) => spm.firmId === connectedUser.firmId)).toHaveLength(
      0,
    );
    const spmSessions = state.sessions.filter(
      (session) => session.firmId === connectedUser.firmId && session.kind === 'spm',
    );
    expect(spmSessions).toHaveLength(1);
    expect(spmSessions[0].used).toBe(false);
  });

  test(
    'merely loading /stored-payment-methods mints a save-payment-method token, with no click',
    {
      annotation: {
        type: 'quirk',
        description:
          'NOT in QUIRKS.md as of its 19 entries — same shape as #15. ' +
          'src/pages/stored-payment-methods.tsx:16 renders ' +
          '<CreateStoredPaymentMethodModal> unconditionally, and that component calls ' +
          'useSavePaymentMethodToken() at CreateStoredPaymentMethodModal.tsx:43. The ' +
          'hook fires its fetch from a useEffect with an empty dependency array ' +
          '(useSavePaymentMethodToken.ts:21-23), so the token is minted when the PAGE ' +
          'mounts, not when the modal opens. Simply visiting /stored-payment-methods ' +
          'runs createSavePaymentMethodToken against Confido — a state-changing call ' +
          'the user never asked for — and it is minted exactly once per page load, ' +
          'which is what the next test builds on.',
      },
    },
    async ({ page, mock, connectedUser }) => {
      const mark = await mock.events.mark();

      await page.goto('/stored-payment-methods');
      await expect(
        page.getByRole('button', { name: 'Save New Payment Method' }),
      ).toBeVisible();

      // No click has happened and none will.
      const event = await mock.events.waitFor({
        op: 'CreateSavePaymentMethodToken',
        firmId: connectedUser.firmId,
        since: mark,
      });
      expect(event.ok).toBe(true);
      expect(event.tokenKind).toBe('firm');

      // The dialog was never opened, so nothing on screen could have triggered it.
      await expect(modal(page)).toHaveCount(0);
      await expect(hostedField(page, 'cardNumber')).toHaveCount(0);

      // …and a real, unused session now exists on the Confido side for this firm.
      const state = await mock.state();
      const spmSessions = state.sessions.filter(
        (session) => session.firmId === connectedUser.firmId && session.kind === 'spm',
      );
      expect(spmSessions).toHaveLength(1);
      expect(spmSessions[0].used).toBe(false);
    },
  );

  test(
    'the one-time token is not re-minted on reopen, so a second save fails on the used session',
    {
      annotation: {
        type: 'quirk',
        description:
          'Consequence of the page-load minting above. `token` lives in ' +
          'useSavePaymentMethodToken, which is mounted by the always-rendered ' +
          'CreateStoredPaymentMethodModal, so it survives closing the dialog; only ' +
          'StorePaymentMethodForm (and its `result` state, …Modal.tsx:84) unmounts. ' +
          'Reopening therefore shows a pristine, fully usable form bound to a token ' +
          'Confido has already consumed. The second Save round-trips all the way to ' +
          'the API before failing, and the failure is shown as the raw serialised ' +
          'graphql-request error at …Modal.tsx:159. Only a full page reload recovers.',
      },
    },
    async ({ page, mock, connectedUser }) => {
      const dialog = await openModal(page);

      await dialog.getByLabel('Client name').fill('Ada Lovelace');
      await dialog.getByLabel('Email').fill('ada@example.com');
      await fillCardFields(page, CARDS.visaSuccess);
      const first = await savePaymentMethodAndCaptureResponse(page, async () => {
        await page.getByRole('button', { name: 'Save', exact: true }).click();
      });
      expect(first.status).toBe(200);
      await expect(dialog.getByRole('heading', { name: 'Success!' })).toBeVisible();

      await successCloseButton(page).click();
      await expect(dialog).toBeHidden();

      const mark = await mock.events.mark();
      await page.getByRole('button', { name: 'Save New Payment Method' }).click();
      await expect(dialog).toBeVisible();

      // The form is back, with no trace of the success body — but no `Loading...`
      // and no second token, because the hook's effect already ran.
      await expect(dialog.getByRole('heading', { name: 'Success!' })).toHaveCount(0);
      await expect(dialog.getByLabel('Client name')).toBeVisible();
      await expect(hostedField(page, 'cardNumber')).toBeAttached();
      await expect(dialog.getByText('Loading...')).toHaveCount(0);
      expect(
        await mock.events.count({
          op: 'CreateSavePaymentMethodToken',
          firmId: connectedUser.firmId,
          since: mark,
        }),
      ).toBe(0);

      await dialog.getByLabel('Client name').fill('Ada Lovelace');
      await dialog.getByLabel('Email').fill('ada@example.com');
      await fillCardFields(page, CARDS.visaSuccess);
      const second = await savePaymentMethodAndCaptureResponse(page, async () => {
        await page.getByRole('button', { name: 'Save', exact: true }).click();
      });
      expect(second.status).toBe(500);
      expect(second.body).toMatchObject({
        error: expect.stringContaining('Payment session already completed'),
      });

      // The user sees the raw graphql-request message, not a handled error.
      await expect(dialog.getByText(/Payment session already completed/)).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Success!' })).toHaveCount(0);

      const failed = await mock.events.waitFor({
        op: 'CompleteSavePaymentMethod',
        firmId: connectedUser.firmId,
        since: mark,
        where: (candidate) => candidate.ok === false,
      });
      expect(failed.errorMessage).toBe('Payment session already completed');

      // And the firm still has exactly the one payment method it saved first.
      const state = await mock.state();
      expect(
        state.spms.filter((spm) => spm.firmId === connectedUser.firmId),
      ).toHaveLength(1);
    },
  );

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
