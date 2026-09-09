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
 * Both tests are fully parallel-safe. Payment links are scoped per firm in the
 * mock (`store.ts` keys them by `(firmId, id)`, PLAN.md §3.4), so seeding the
 * hardcoded id for one firm leaves every other firm still getting
 * `Paylink not found`. That mirrors the real API — a paylink belongs to a firm,
 * which is the very reason this page is broken for everyone but its author — and
 * it means these two tests do not have to be ordered or serialised.
 */

import type { Locator, Page } from '@playwright/test';
import {
  CARDS,
  CARD_FIELD_KEYS,
  PAYLINKS_PAGE_PAYMENT_LINK_ID,
  expect,
  fillCardFields,
  hostedField,
  runPaymentAndCaptureResponse,
  test,
  waitForHostedFields,
} from '../fixtures/test';
import type { MockEvent } from '../fixtures/test';

/** The total the seeded payment link carries, in cents ($250.00). */
const PAYLINK_TOTAL_CENTS = 25_000;

interface PaymentBody {
  id: string;
  status: string;
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
