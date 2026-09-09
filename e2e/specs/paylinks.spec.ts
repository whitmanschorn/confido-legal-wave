/**
 * `/paylinks` — the Payment Links vehicle (PLAN.md §6).
 *
 * This page is the most broken one in the app, and both halves of that are
 * asserted here:
 *
 * 1. `src/pages/paylinks.tsx:24` hardcodes
 *    `paymentLinkId = 'a1e7a82e-b59e-4645-b559-22e12bfb265c'` — a link belonging
 *    to whoever wrote the page — and passes it to `createPaymentToken` inside
 *    `getServerSideProps` with no error handling. Against the real sandbox every
 *    other firm gets `Paylink not found`, so the route 500s before it renders
 *    (QUIRKS.md #7). The mock reproduces that by default.
 * 2. Seed that exact id and the form works — but `PaylinkPaymentForm.tsx` has no
 *    success UI at all: `{!result && …}` at `:119` is the only branch, so a
 *    successful payment simply makes the form vanish.
 *
 * The remaining tests add depth §6 does not ask for but the page badly needs:
 * the ACH panel, the store-payment-method checkbox, the surcharging notice that
 * promises a fee the form never charges, and the unguarded `paymentLink`
 * dereference of QUIRKS.md #6.
 *
 * Every test is fully parallel-safe. Payment links are scoped per firm in the
 * mock (`store.ts` keys them by `(firmId, id)`, PLAN.md §3.4), so seeding the
 * hardcoded id for one firm leaves every other firm still getting
 * `Paylink not found`. That mirrors the real API — a paylink belongs to a firm,
 * which is the very reason this page is broken for everyone but its author — and
 * it means the 500 test and the seeded ones do not have to be ordered or
 * serialised.
 */

import type { Locator, Page } from '@playwright/test';
import {
  ACH,
  ACH_FIELD_KEYS,
  CARDS,
  CARD_FIELD_KEYS,
  PAYLINKS_PAGE_PAYMENT_LINK_ID,
  expect,
  fillAchFields,
  fillCardFields,
  hostedField,
  runPaymentAndCaptureResponse,
  test,
  waitForHostedFields,
} from '../fixtures/test';
import type { MockControl, MockEvent, SessionView } from '../fixtures/test';

/** The total the seeded payment link carries, in cents ($250.00). */
const PAYLINK_TOTAL_CENTS = 25_000;

interface PaymentBody {
  id: string;
  status: string;
  storedPaymentMethod: {
    id: string;
    lastFour: string;
    cardBrand: string;
    paymentMethod: string;
    payerName: string | null;
  } | null;
  transactions: Array<{
    id: string;
    amountProcessed: number;
    payRequest: { externalId: string | null };
  }>;
}

function inputOf(event: MockEvent): Record<string, unknown> {
  const variables = event.variables as { input?: Record<string, unknown> };
  return variables.input ?? {};
}

function runPayment(page: Page): Locator {
  return page.getByRole('button', { name: 'Run payment' });
}

/** Seeds the hardcoded link for this firm and opens the page with card fields up. */
async function openSeededPaylinks(
  page: Page,
  mock: MockControl,
  firmId: string,
): Promise<void> {
  await mock.paylinks.seedPaylinksPage(firmId, PAYLINK_TOTAL_CENTS);
  const response = await page.goto('/paylinks');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Payment Links' })).toBeVisible();
  await waitForHostedFields(page, CARD_FIELD_KEYS);
}

test(
  'the Paylinks page 500s for every firm but the one that owns the hardcoded link',
  {
    annotation: {
      type: 'quirk',
      description:
        'QUIRKS.md #7 — src/pages/paylinks.tsx:24 hardcodes paymentLinkId ' +
        '"a1e7a82e-b59e-4645-b559-22e12bfb265c" and passes it to createPaymentToken in ' +
        'getServerSideProps with no try/catch, so /paylinks 500s for every account except the ' +
        'page author’s. (QUIRKS.md cites line 29; the literal is on line 24 of this checkout.)',
    },
  },
  async ({ page, connectedUser, mock }) => {
    // Paylinks are firm-scoped in the mock (PLAN.md §3.4), so this firm cannot
    // see the link even when a parallel test has seeded it for its own firm.
    // That scoping is what lets this test and the seeded one below coexist.
    const state = await mock.state();
    const seededForThisFirm = state.paylinks.filter(
      (link) =>
        link.id === PAYLINKS_PAGE_PAYMENT_LINK_ID && link.firmId === connectedUser.firmId,
    );
    expect(seededForThisFirm).toHaveLength(0);

    const mark = await mock.events.mark();
    const response = await page.goto('/paylinks');

    expect(response).not.toBeNull();
    expect(response?.status()).toBe(500);
    await expect(page.getByRole('heading', { name: 'Payment Links' })).toHaveCount(0);
    await expect(runPayment(page)).toHaveCount(0);

    // And the reason is exactly the one above, not a firm-status problem: the
    // firm is ACTIVE, and the mock rejects the paylink before it ever looks at
    // the firm (mock-server/resolvers.ts:376-383).
    const firm = await mock.firms.get(connectedUser.firmId);
    expect(firm.status).toBe('ACTIVE');
    expect(firm.isAcceptingPayments).toBe(true);

    const event = await mock.events.waitFor({
      op: 'CreatePaymentToken',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(inputOf(event).paymentLinkId).toBe(PAYLINKS_PAGE_PAYMENT_LINK_ID);
    expect(event.ok).toBe(false);
    expect(event.errorMessage).toBe('Paylink not found');
  },
);

test(
  'with the link seeded the form pays the link total, but shows no success at all',
  {
    annotation: {
      type: 'quirk',
      description:
        'PaylinkPaymentForm.tsx renders only `{!result && …}` (:119) — there is no `{result && …}` ' +
        'branch and `PaymentResult` is an empty interface (:38). A successful payment therefore ' +
        'unmounts the form and renders nothing: no "Success!", no result JSON, no receipt, no way ' +
        'back. Related: `:76` reads `hostedFieldsState?.paymentLink.totalAmount`, where the ' +
        'optional chain stops at `hostedFieldsState` and `paymentLink` is dereferenced unguarded ' +
        '(QUIRKS.md #6).',
    },
  },
  async ({ page, connectedUser, mock }) => {
    const link = await mock.paylinks.seedPaylinksPage(
      connectedUser.firmId,
      PAYLINK_TOTAL_CENTS,
    );
    expect(link.id).toBe(PAYLINKS_PAGE_PAYMENT_LINK_ID);
    expect(link.totalAmount).toBe(PAYLINK_TOTAL_CENTS);

    const mark = await mock.events.mark();
    const response = await page.goto('/paylinks');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Payment Links' })).toBeVisible();

    const tokenEvent = await mock.events.waitFor({
      op: 'CreatePaymentToken',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(tokenEvent.ok).toBe(true);
    expect(inputOf(tokenEvent).paymentLinkId).toBe(PAYLINKS_PAGE_PAYMENT_LINK_ID);

    await waitForHostedFields(page, CARD_FIELD_KEYS);

    // The amount is not an input at all: `PaylinkPaymentForm.tsx:131` prints
    // `state.paymentLink.totalAmount` as a bare `<Text>` in raw cents, and the
    // `Amount` FormControl below it (`:133-141`) has a label and no control.
    await expect(page.getByText(String(PAYLINK_TOTAL_CENTS), { exact: true })).toBeVisible();
    await expect(page.getByText('Amount', { exact: true })).toBeVisible();
    await expect(page.locator('#amount')).toHaveCount(0);

    // Unlike Payment Intents, this page uses real `TabPanels` (`:162-211`), so
    // the inactive panel's fields are hidden by Chakra rather than by `hidden`
    // props the form sets itself.
    await expect(hostedField(page, 'cardNumber')).toBeVisible();
    await expect(hostedField(page, 'accountNumber')).not.toBeVisible();
    await page.getByRole('tab', { name: 'Bank Account' }).click();
    await expect(hostedField(page, 'accountNumber')).toBeVisible();
    await expect(hostedField(page, 'cardNumber')).not.toBeVisible();
    await page.getByRole('tab', { name: 'Card' }).click();
    await expect(hostedField(page, 'cardNumber')).toBeVisible();

    await page.getByLabel('Email for receipt').fill('ada@example.test');
    await fillCardFields(page, CARDS.visaSuccess);

    const payMark = await mock.events.mark();
    const { status, body } = await runPaymentAndCaptureResponse(page, async () => {
      await runPayment(page).click();
    });

    expect(status).toBe(200);
    const payment = body as PaymentBody;
    expect(payment.status).toBe('success');
    // The proof that the amount came from `state.paymentLink.totalAmount` and
    // not from any form field: there is no amount input on this page.
    expect(payment.transactions).toHaveLength(1);
    expect(payment.transactions[0].amountProcessed).toBe(PAYLINK_TOTAL_CENTS);

    const paidEvent = await mock.events.waitFor({
      op: 'PaymentSessionComplete',
      firmId: connectedUser.firmId,
      since: payMark,
    });
    expect(paidEvent.ok).toBe(true);
    const paidInput = inputOf(paidEvent);
    expect(paidInput.amount).toBe(PAYLINK_TOTAL_CENTS);
    expect(paidInput.method).toBe('CREDIT');
    expect(paidInput.payerEmail).toBe('ada@example.test');

    // The quirk: the form unmounts and nothing replaces it.
    await expect(runPayment(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Success!' })).toHaveCount(0);
    await expect(page.getByText('Collect more')).toHaveCount(0);
    await expect(page.locator('.chakra-alert')).toHaveCount(0);
    // The left-hand marketing column is all that is left on screen.
    await expect(page.getByText('Payment Links are awesome.')).toBeVisible();
  },
);

// ---------------------------------------------------------------------------
// Depth beyond §6: the ACH panel, the store-payment-method checkbox, the
// surcharging notice, and the unguarded `paymentLink` dereference (QUIRKS.md #6).
// ---------------------------------------------------------------------------

test('the Bank Account panel pays the same link total as ACH', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openSeededPaylinks(page, mock, connectedUser.firmId);

  await page.getByRole('tab', { name: 'Bank Account' }).click();
  // Real `TabPanels` here (PaylinkPaymentForm.tsx:162-211), so the ACH inputs
  // are only attached once the panel is selected.
  await waitForHostedFields(page, ACH_FIELD_KEYS);
  await expect(hostedField(page, 'cardNumber')).not.toBeVisible();

  await page.getByLabel('Email for receipt').fill('grace@example.test');
  await fillAchFields(page, ACH.valid);

  const mark = await mock.events.mark();
  const { status, body } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });

  expect(status).toBe(200);
  const payment = body as PaymentBody;
  expect(payment.status).toBe('success');
  expect(payment.transactions).toHaveLength(1);
  // Still the link total: `PaylinkPaymentForm.tsx:76` reads it from
  // `state.paymentLink`, which is independent of the tab.
  expect(payment.transactions[0].amountProcessed).toBe(PAYLINK_TOTAL_CENTS);

  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(event.ok).toBe(true);
  const input = inputOf(event);
  expect(input.method).toBe('ACH');
  expect(input.amount).toBe(PAYLINK_TOTAL_CENTS);
  expect(input.payerEmail).toBe('grace@example.test');
  // The paylinks form has no Name field at all, unlike Payment Intents.
  expect(input.payerName ?? null).toBeNull();

  // Same missing success state as the card path (QUIRKS.md #18).
  await expect(runPayment(page)).toHaveCount(0);
});

test('Store payment method on a paylink stores the card', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openSeededPaylinks(page, mock, connectedUser.firmId);

  await page.getByLabel('Email for receipt').fill('ada@example.test');
  await fillCardFields(page, CARDS.visaSuccess);
  await page.getByText('Store payment method').click();

  const mark = await mock.events.mark();
  const { status, body } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });

  expect(status).toBe(200);
  const payment = body as PaymentBody;
  expect(payment.storedPaymentMethod).not.toBeNull();
  expect(payment.storedPaymentMethod?.lastFour).toBe(CARDS.visaSuccess.lastFour);
  expect(payment.storedPaymentMethod?.paymentMethod).toBe('CREDIT');

  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(inputOf(event).savePaymentMethod).toBe(true);

  // …and, per QUIRKS.md #18, the user is never shown any of it.
  await expect(runPayment(page)).toHaveCount(0);
  await expect(page.getByText(CARDS.visaSuccess.lastFour)).toHaveCount(0);
});

test(
  'the surcharging notice appears on the card tab but no fee is ever charged',
  {
    annotation: {
      type: 'quirk',
      description:
        'Suspected new quirk. PaylinkPaymentForm.tsx:135-140 renders "a 3% surcharging fee will ' +
        'be added" whenever `state.surcharging.willBeApplied`, but the form never calls ' +
        '`recalculateSurcharging` (compare PaymentForm.tsx:143-151) and posts ' +
        '`amount: state.paymentLink.totalAmount` unchanged (:76). The payer is told a fee will be ' +
        'added and is then charged exactly the link total, with no fee shown and none applied.',
    },
  },
  async ({ page, connectedUser, mock }) => {
    const firm = await mock.firms.surcharging(connectedUser.firmId, true);
    expect(firm.surchargingEnabled).toBe(true);

    await openSeededPaylinks(page, mock, connectedUser.firmId);

    const notice = page.getByText('a 3% surcharging fee will be added');
    await expect(notice).toBeVisible();
    // Unlike Payment Intents (PaymentForm.tsx:268-281) there is no fee alert…
    await expect(page.getByText('will be added to your total.')).toHaveCount(0);

    // shims/hosted-fields.js:101-114 — surcharging is card-and-CREDIT only.
    await page.getByRole('tab', { name: 'Bank Account' }).click();
    await expect(notice).toHaveCount(0);
    await page.getByRole('tab', { name: 'Card' }).click();
    await expect(notice).toBeVisible();

    await page.getByLabel('Email for receipt').fill('ada@example.test');
    await fillCardFields(page, CARDS.visaSuccess);

    const mark = await mock.events.mark();
    const { status, body } = await runPaymentAndCaptureResponse(page, async () => {
      await runPayment(page).click();
    });

    expect(status).toBe(200);
    // …and the promised 3% never reaches the wire: 25000, not 25750.
    const payment = body as PaymentBody;
    expect(payment.transactions[0].amountProcessed).toBe(PAYLINK_TOTAL_CENTS);

    const event = await mock.events.waitFor({
      op: 'PaymentSessionComplete',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(inputOf(event).amount).toBe(PAYLINK_TOTAL_CENTS);
  },
);

test(
  'a session without a payment link crashes the whole page on Run payment',
  {
    annotation: {
      type: 'quirk',
      description:
        'QUIRKS.md #6 — PaylinkPaymentForm.tsx:76 dereferences `paymentLink` unguarded ' +
        '(`hostedFieldsState?.paymentLink.totalAmount`), so a session with no payment link throws ' +
        'a TypeError before the fetch is built: no /api/complete-payment is sent. The catch at ' +
        ':89-91 then calls `setError(e)` and :112-117 renders `<span>{error}</span>` with an Error ' +
        'OBJECT as a React child, which React refuses to render — so the page does NOT show an ' +
        'alert (as QUIRKS.md #6 currently says) but unmounts entirely into Next’s "Application ' +
        'error: a client-side exception has occurred".',
    },
  },
  async ({ page, connectedUser, mock }) => {
    // Serve the hosted-fields shim a session with `paymentLink: null` — exactly
    // what any non-paylink session looks like (SessionView.paymentLink is
    // nullable, mock-server/types.ts:277). Only the shim's GET is rewritten;
    // the POST …/stage still reaches the mock, so `submitFields` succeeds and
    // the failure is unambiguously the dereference at :76.
    await page.route('**/__control/sessions/*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const view = (await response.json()) as SessionView;
      expect(view.paymentLink).not.toBeNull();
      view.paymentLink = null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(view),
      });
    });

    let completeCalls = 0;
    page.on('request', (request) => {
      if (request.url().indexOf('/api/complete-payment') !== -1) completeCalls += 1;
    });

    await openSeededPaylinks(page, mock, connectedUser.firmId);
    // The total is missing from the panel, which is the visible tell.
    await expect(
      page.getByText(String(PAYLINK_TOTAL_CENTS), { exact: true }),
    ).toHaveCount(0);

    await page.getByLabel('Email for receipt').fill('ada@example.test');
    await fillCardFields(page, CARDS.visaSuccess);

    const mark = await mock.events.mark();
    await runPayment(page).click();

    await expect(
      page.getByText('Application error: a client-side exception has occurred'),
    ).toBeVisible();
    await expect(runPayment(page)).toHaveCount(0);
    await expect(page.locator('.chakra-alert')).toHaveCount(0);

    // Nothing was charged, and nothing reached Confido.
    expect(completeCalls).toBe(0);
    expect(
      await mock.events.count({
        op: 'PaymentSessionComplete',
        firmId: connectedUser.firmId,
        since: mark,
      }),
    ).toBe(0);
  },
);
