/**
 * `/payment-intents` — the Payment Intents vehicle (PLAN.md §6).
 *
 * Notes that shaped these tests, all verified against the source:
 *
 * - `PaymentForm.tsx` renders the card **and** ACH hosted fields at the same
 *   time and hides the inactive set with `hidden` (`:253`, `:298`, and the
 *   comment at `:240`). Paylinks uses real `TabPanels`; this page does not.
 * - The submit button is `Run payment`; `Submit fields only (test)` sits next to
 *   it and must never be confused for it (`:343`, `:346`).
 * - The `Name` field's label points at the wrong control:
 *   `<FormLabel htmlFor='email'>Name</FormLabel>` over `<Input id='name'>`
 *   (`PaymentForm.tsx:228-229`), so `getByLabel('Name')` resolves to the email
 *   input. Every test below addresses that field as `#name`, as PLAN.md §0 says.
 * - `PaymentForm.tsx:107-109` only calls `setResult` when `response.ok`. A
 *   non-OK response is swallowed: no error, no message, the form just sits
 *   there. The decline tests assert exactly that.
 */

import type { Locator, Page } from '@playwright/test';
import {
  ACH,
  AMOUNTS,
  CARDS,
  dollarsToCents,
  expect,
  fillAchFields,
  fillCardFields,
  hostedField,
  runPaymentAndCaptureResponse,
  test,
  waitForHostedFields,
} from '../fixtures/test';
import type { MockEvent } from '../fixtures/test';

// ---------------------------------------------------------------------------
// Shapes and selectors
// ---------------------------------------------------------------------------

/** The JSON `POST /api/complete-payment` echoes back from `paymentSessionComplete`. */
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

/**
 * `CreditCardBrandIcon` inlines an SVG with no title, alt or aria-label
 * (PLAN.md §0), so the only honest hook is the brand's fill colour.
 */
const BRAND_FILL = {
  visa: 'path[fill="#0E4595"]',
  mastercard: 'path[fill="#D9222A"]',
  generic: 'path[fill="#9D9400"]',
} as const;

/**
 * The brand icon lives in the `InputRightElement` that follows the
 * `Input id='card-number'` inside its `InputGroup`, so scoping by sibling keeps
 * this away from any other SVG on the page.
 */
function cardBrandIcon(page: Page, brand: keyof typeof BRAND_FILL): Locator {
  return page.locator(`#card-number ~ * ${BRAND_FILL[brand]}`);
}

function runPayment(page: Page): Locator {
  return page.getByRole('button', { name: 'Run payment' });
}

function successHeading(page: Page): Locator {
  return page.getByRole('heading', { name: 'Success!' });
}

/** `variables.input` off a recorded mock event, without any `any`. */
function inputOf(event: MockEvent): Record<string, unknown> {
  const variables = event.variables as { input?: Record<string, unknown> };
  return variables.input ?? {};
}

function asPayment(body: unknown): PaymentBody {
  return body as PaymentBody;
}

/**
 * The `paymentToken` `getServerSideProps` minted for the page that is currently
 * loaded, read out of Next's own hydration payload
 * (`payment-intents.tsx:25-33` puts it in `pageProps`).
 *
 * This is the only honest way to prove `Collect more` starts a *new* session:
 * a `CreatePaymentToken` event alone would also fire for a token the page then
 * ignored, or for a cached one.
 */
async function currentPaymentToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __NEXT_DATA__?: { props?: { pageProps?: { paymentToken?: string } } };
    };
    return win.__NEXT_DATA__?.props?.pageProps?.paymentToken ?? '';
  });
}

/** Amount, name and email — the three plain form fields above the tabs. */
async function fillPayerDetails(
  page: Page,
  options: { amount: string; name?: string; email?: string },
): Promise<void> {
  await page.getByLabel('Amount', { exact: true }).fill(options.amount);
  if (options.name !== undefined) await page.locator('#name').fill(options.name);
  if (options.email !== undefined) {
    await page.getByLabel('Email for receipt').fill(options.email);
  }
}

/** Opens the page and waits until the shim has rendered all six inputs. */
async function openPaymentIntents(page: Page): Promise<void> {
  await page.goto('/payment-intents');
  await expect(page.getByRole('heading', { name: 'Payment Intents' })).toBeVisible();
  await waitForHostedFields(page);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('renders the six hosted fields, spinners cleared, and creates a payment session', async ({
  page,
  connectedUser,
  mock,
}) => {
  const mark = await mock.events.mark();
  await openPaymentIntents(page);

  const event = await mock.events.waitFor({
    op: 'CreatePaymentToken',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(event.ok).toBe(true);
  // The Payment Intents page passes no paymentLinkId — unlike Paylinks.
  expect(inputOf(event).paymentLinkId ?? null).toBeNull();

  // Card first: both sets of fields are mounted at once and the inactive set is
  // hidden with `hidden` (PaymentForm.tsx:240 explains why), so the ACH labels
  // are attached but not visible while the Card tab is selected.
  const cardLabels = ['Card Number', 'Exp', 'CVV'];
  for (let i = 0; i < cardLabels.length; i += 1) {
    await expect(page.getByText(cardLabels[i], { exact: true })).toBeVisible();
  }
  const achLabels = ['Account Name', 'Account Number', 'Routing Number'];
  for (let j = 0; j < achLabels.length; j += 1) {
    await expect(page.getByText(achLabels[j], { exact: true })).toBeAttached();
    await expect(page.getByText(achLabels[j], { exact: true })).not.toBeVisible();
  }

  // "six hosted-field inputs present", literally: the shim appends exactly one
  // `<input data-testid="hf-…">` per container id `useConfidoLegal.ts:66-91`
  // passes, so anything but six means a container was dropped or duplicated.
  await expect(page.locator('[data-testid^="hf-"]')).toHaveCount(6);

  // `HostedFieldInput.tsx:26` spins until `fieldState.loading === false`, so an
  // empty spinner set is the proof that the SDK reported the fields as ready.
  await expect(page.locator('.chakra-spinner')).toHaveCount(0);

  await expect(runPayment(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit fields only (test)' })).toBeVisible();
});

test('typing a card number renders the matching brand icon', async ({
  page,
  connectedUser,
  mock,
}) => {
  expect(connectedUser.firmId).toBeTruthy();
  expect(mock.baseUrl).toContain('7002');
  await openPaymentIntents(page);

  // No digits yet → `state.cardData` is undefined → `CreditCardBrandIcon`
  // falls back to the generic logo (`CreditCardBrandIcon.tsx:44`).
  await expect(cardBrandIcon(page, 'generic')).toBeVisible();

  await hostedField(page, 'cardNumber').fill(CARDS.visaSuccess.number);
  await expect(cardBrandIcon(page, 'visa').first()).toBeVisible();
  await expect(cardBrandIcon(page, 'generic')).toHaveCount(0);

  await hostedField(page, 'cardNumber').fill(CARDS.mastercardSuccess.number);
  await expect(cardBrandIcon(page, 'mastercard').first()).toBeVisible();
  await expect(cardBrandIcon(page, 'visa')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a Visa card payment succeeds end to end', async ({ page, connectedUser, mock }) => {
  await openPaymentIntents(page);
  await fillPayerDetails(page, {
    amount: AMOUNTS.tenDollars,
    name: 'Ada Lovelace',
    email: 'ada@example.test',
  });
  await fillCardFields(page, CARDS.visaSuccess);

  // `sendReceipt` starts indeterminate (`PaymentForm.tsx:329`); one click on
  // the label makes it an explicit `true` so the mutation carries the field.
  await page.getByText('Send receipt').click();
  await expect(page.getByText('Send receipt')).toContainText('true');

  const mark = await mock.events.mark();
  const { status, body } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });

  expect(status).toBe(200);
  const payment = asPayment(body);
  expect(payment.status).toBe('success');
  expect(payment.transactions).toHaveLength(1);
  expect(payment.transactions[0].amountProcessed).toBe(
    dollarsToCents(AMOUNTS.tenDollars),
  );

  await expect(successHeading(page)).toBeVisible();
  // The rendered `<Code>` block is `JSON.stringify(result, null, 2)`
  // (PaymentForm.tsx:183), so both of §6's literal strings must be on screen.
  await expect(page.getByText('"status": "success"')).toBeVisible();
  await expect(
    page.getByText(`"amountProcessed": ${dollarsToCents(AMOUNTS.tenDollars)}`),
  ).toBeVisible();

  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(event.ok).toBe(true);
  const input = inputOf(event);
  expect(input.method).toBe('CREDIT');
  expect(input.amount).toBe(dollarsToCents(AMOUNTS.tenDollars));
  expect(input.payerEmail).toBe('ada@example.test');
  expect(input.payerName).toBe('Ada Lovelace');
  expect(input.sendReceipt).toBe(true);
  // The app mints the externalId itself (paymentSessionComplete.ts:82).
  expect(typeof input.externalId).toBe('string');
  expect(payment.transactions[0].payRequest.externalId).toBe(input.externalId);
});

test('the external-id lookup finds the pay request the payment just created', async ({
  page,
  connectedUser,
  mock,
}) => {
  expect(connectedUser.firmId).toBeTruthy();
  await openPaymentIntents(page);
  await fillPayerDetails(page, {
    amount: AMOUNTS.tenDollars,
    name: 'Grace Hopper',
    email: 'grace@example.test',
  });
  await fillCardFields(page, CARDS.visaSuccess);

  const mark = await mock.events.mark();
  const { body } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });
  await expect(successHeading(page)).toBeVisible();

  // The externalId is generated server-side, so the only way to know it is to
  // read it back out of the response body.
  const externalId = asPayment(body).transactions[0].payRequest.externalId;
  expect(typeof externalId).toBe('string');

  await page.getByPlaceholder('Enter external ID...').fill(externalId as string);
  await page.getByRole('button', { name: 'Lookup' }).click();

  // Chakra's `ModalHeader` renders a `<header>`, not a heading, so the title is
  // matched as text rather than by role.
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Pay Request Data');
  await expect(modal).toContainText(externalId as string);
  await expect(modal).toContainText('payRequestList');

  const lookup = await mock.events.waitFor({
    op: 'PayRequestList',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(lookup.ok).toBe(true);
  expect(inputOf(lookup).externalId).toBe(externalId);
});

test('Collect more reloads the page and starts a fresh payment session', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openPaymentIntents(page);
  const firstToken = await currentPaymentToken(page);
  expect(firstToken).not.toBe('');

  await fillPayerDetails(page, { amount: AMOUNTS.tenDollars, name: 'Ada Lovelace' });
  await fillCardFields(page, CARDS.visaSuccess);
  await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });
  await expect(successHeading(page)).toBeVisible();

  const mark = await mock.events.mark();
  await page.getByRole('button', { name: 'Collect more' }).click();

  // `router.reload()` re-runs getServerSideProps, which mints a new token.
  const event = await mock.events.waitFor({
    op: 'CreatePaymentToken',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(event.ok).toBe(true);

  await expect(successHeading(page)).toHaveCount(0);
  await expect(runPayment(page)).toBeVisible();
  await waitForHostedFields(page);

  // The point of the bullet: the session really is *fresh*. An event alone
  // would still fire if the page re-rendered with the token it already had, so
  // compare the token Next hydrated the second render with against the first.
  const secondToken = await currentPaymentToken(page);
  expect(secondToken).not.toBe('');
  expect(secondToken).not.toBe(firstToken);
  // Exactly one new token, not a retry storm.
  expect(
    await mock.events.count({
      op: 'CreatePaymentToken',
      firmId: connectedUser.firmId,
      since: mark,
    }),
  ).toBe(1);

  // And the mock agrees about which is which: `store.ts:398` marks a session
  // used once `paymentSessionComplete` lands, so the first is spent and the
  // second has never been charged. A reused token would fail both of these.
  const spent = await mock.sessions.get(firstToken);
  expect(spent.used).toBe(true);
  const fresh = await mock.sessions.get(secondToken);
  expect(fresh.used).toBe(false);
  expect(fresh.firmId).toBe(connectedUser.firmId);

  // The new session starts empty — nothing the previous payment typed survives.
  await expect(hostedField(page, 'cardNumber')).toHaveValue('');
});

test('checking Store payment method returns a stored payment method on the result', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openPaymentIntents(page);
  await fillPayerDetails(page, {
    amount: AMOUNTS.tenDollars,
    name: 'Ada Lovelace',
    email: 'ada@example.test',
  });
  await fillCardFields(page, CARDS.visaSuccess);
  await page.getByText('Store payment method').click();

  const mark = await mock.events.mark();
  const { body } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });

  const payment = asPayment(body);
  expect(payment.storedPaymentMethod).not.toBeNull();
  expect(payment.storedPaymentMethod?.lastFour).toBe(CARDS.visaSuccess.lastFour);
  expect(payment.storedPaymentMethod?.cardBrand).toBe('visa');
  expect(payment.storedPaymentMethod?.paymentMethod).toBe('CREDIT');

  await expect(successHeading(page)).toBeVisible();
  await expect(page.getByText(`"lastFour": "${CARDS.visaSuccess.lastFour}"`)).toBeVisible();

  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(inputOf(event).savePaymentMethod).toBe(true);
});

// ---------------------------------------------------------------------------
// ACH
// ---------------------------------------------------------------------------

test('a bank-account payment succeeds and is recorded as ACH', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openPaymentIntents(page);
  await fillPayerDetails(page, {
    amount: AMOUNTS.tenDollars,
    name: 'Ada Lovelace',
    email: 'ada@example.test',
  });

  await page.getByRole('tab', { name: 'Bank Account' }).click();
  // The card boxes are still mounted, just `hidden` (PaymentForm.tsx:253).
  await expect(hostedField(page, 'cardNumber')).toBeAttached();
  await expect(hostedField(page, 'cardNumber')).not.toBeVisible();
  await expect(hostedField(page, 'accountNumber')).toBeVisible();

  await fillAchFields(page, ACH.valid);

  const mark = await mock.events.mark();
  const { status, body } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });

  expect(status).toBe(200);
  const payment = asPayment(body);
  expect(payment.status).toBe('success');
  expect(payment.transactions[0].amountProcessed).toBe(
    dollarsToCents(AMOUNTS.tenDollars),
  );
  await expect(successHeading(page)).toBeVisible();

  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(event.ok).toBe(true);
  expect(inputOf(event).method).toBe('ACH');
});

test(
  'an invalid routing number is declined and the page shows nothing at all',
  {
    annotation: {
      type: 'quirk',
      description:
        'PaymentForm.tsx:107-109 only calls setResult when response.ok, and the catch at :112 ' +
        'never runs for a non-OK response — so a declined ACH payment leaves the form untouched ' +
        'with no error message anywhere.',
    },
  },
  async ({ page, connectedUser, mock }) => {
    await openPaymentIntents(page);
    await fillPayerDetails(page, { amount: AMOUNTS.tenDollars, name: 'Ada Lovelace' });
    await page.getByRole('tab', { name: 'Bank Account' }).click();
    await fillAchFields(page, ACH.invalidRouting);

    const mark = await mock.events.mark();
    const { status } = await runPaymentAndCaptureResponse(page, async () => {
      await runPayment(page).click();
    });

    expect(status).toBe(500);
    const event = await mock.events.waitFor({
      op: 'PaymentSessionComplete',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(event.ok).toBe(false);
    expect(event.errorMessage).toBe('Invalid bank account');

    await expect(successHeading(page)).toHaveCount(0);
    await expect(page.locator('.chakra-alert')).toHaveCount(0);
    await expect(runPayment(page)).toBeVisible();
  },
);

// ---------------------------------------------------------------------------
// Declines
// ---------------------------------------------------------------------------

test(
  'a declined card produces no Success! and no error message',
  {
    annotation: {
      type: 'quirk',
      description:
        'PaymentForm.tsx:107-109 swallows a non-OK /api/complete-payment response: `setResult` ' +
        'is skipped and nothing sets `error`, so the user sees the untouched form and no ' +
        'indication the card was declined. Only the mock event records the failure.',
    },
  },
  async ({ page, connectedUser, mock }) => {
    await openPaymentIntents(page);
    await fillPayerDetails(page, {
      amount: AMOUNTS.tenDollars,
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    });
    await fillCardFields(page, CARDS.declined);

    const mark = await mock.events.mark();
    const { status } = await runPaymentAndCaptureResponse(page, async () => {
      await runPayment(page).click();
    });

    // graphql-request throws, /api/complete-payment has no try/catch, Next 500s.
    expect(status).toBe(500);

    const event = await mock.events.waitFor({
      op: 'PaymentSessionComplete',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(event.ok).toBe(false);
    expect(event.errorMessage).toBe('Card declined');

    // The quirk itself: no result, no alert, the form still sitting there.
    await expect(successHeading(page)).toHaveCount(0);
    // Scoped to Chakra's own Alert: Next always renders an empty
    // `role="alert"` route announcer, which is not a message to the user.
    await expect(page.locator('.chakra-alert')).toHaveCount(0);
    await expect(runPayment(page)).toBeVisible();
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue(
      AMOUNTS.tenDollars,
    );
  },
);

test('4000100000000000 is declined above the limit', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openPaymentIntents(page);
  await fillPayerDetails(page, {
    amount: AMOUNTS.oneFiftyDollars,
    name: 'Ada Lovelace',
  });
  await fillCardFields(page, CARDS.declinedOverLimit);

  const mark = await mock.events.mark();
  const { status } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });

  expect(status).toBe(500);
  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(event.ok).toBe(false);
  expect(event.errorMessage).toBe('Card declined');
  expect(inputOf(event).amount).toBe(dollarsToCents(AMOUNTS.oneFiftyDollars));
  await expect(successHeading(page)).toHaveCount(0);
});

test('4000100000000000 is approved below the limit', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openPaymentIntents(page);
  await fillPayerDetails(page, { amount: AMOUNTS.fiftyDollars, name: 'Ada Lovelace' });
  await fillCardFields(page, CARDS.declinedOverLimit);

  const mark = await mock.events.mark();
  const { status, body } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });

  expect(status).toBe(200);
  const payment = asPayment(body);
  expect(payment.status).toBe('success');
  expect(payment.transactions[0].amountProcessed).toBe(
    dollarsToCents(AMOUNTS.fiftyDollars),
  );
  await expect(successHeading(page)).toBeVisible();

  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(event.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Surcharging
// ---------------------------------------------------------------------------

test('surcharging shows the notice and the fee, and the bank-account tab hides both', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openPaymentIntents(page);
  const notice = page.getByText('a 3% surcharging fee will be added');
  await expect(notice).toHaveCount(0);

  // The shim reads `surchargingEnabled` off the session when it boots, so the
  // firm has to be switched on before a *new* session is created.
  const firm = await mock.firms.surcharging(connectedUser.firmId, true);
  expect(firm.surchargingEnabled).toBe(true);
  expect(firm.surchargeRate).toBe(0.03);

  await page.reload();
  await waitForHostedFields(page);

  await expect(notice).toBeVisible();
  await expect(
    page.getByText('A fee of $0.00 will be added to your total.'),
  ).toBeVisible();

  await page.getByLabel('Amount', { exact: true }).fill('100.00');
  await expect(
    page.getByText('A fee of $3.00 will be added to your total.'),
  ).toBeVisible();

  // shims/hosted-fields.js:101-114 — surcharging only applies on the card form.
  await page.getByRole('tab', { name: 'Bank Account' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText('will be added to your total.')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Card' }).click();
  await expect(notice).toBeVisible();
  await expect(
    page.getByText('A fee of $3.00 will be added to your total.'),
  ).toBeVisible();
});

test('surcharging does not apply to a debit card', async ({
  page,
  connectedUser,
  mock,
}) => {
  await mock.firms.surcharging(connectedUser.firmId, true);
  await openPaymentIntents(page);

  const notice = page.getByText('a 3% surcharging fee will be added');
  await page.getByLabel('Amount', { exact: true }).fill('100.00');
  await expect(notice).toBeVisible();

  // shims/hosted-fields.js:85-88 — this PAN settles as DEBIT, and
  // `currentSurcharging()` requires CREDIT.
  await hostedField(page, 'cardNumber').fill(CARDS.debitSuccess.number);
  await expect(notice).toHaveCount(0);
  await expect(page.getByText('will be added to your total.')).toHaveCount(0);

  // And it stays a working payment, just an unsurcharged one.
  await page.locator('#name').fill('Ada Lovelace');
  await hostedField(page, 'cardExpirationDate').fill(CARDS.debitSuccess.exp);
  await hostedField(page, 'cardSecurityCode').fill(CARDS.debitSuccess.cvv);

  const mark = await mock.events.mark();
  const { status } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });
  expect(status).toBe(200);
  await expect(successHeading(page)).toBeVisible();

  const event = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,
    since: mark,
  });
  expect(inputOf(event).method).toBe('DEBIT');
});

// ---------------------------------------------------------------------------
// Validation and the unconnected case
// ---------------------------------------------------------------------------

test('empty card fields fail the SDK validation and never reach the API', async ({
  page,
  connectedUser,
  mock,
}) => {
  await openPaymentIntents(page);
  // Amount is the only field react-hook-form requires (PaymentForm.tsx:215);
  // without it `handleSubmit` never calls `submitFields` at all.
  await fillPayerDetails(page, { amount: AMOUNTS.tenDollars, name: 'Ada Lovelace' });

  // Count the browser-side call directly, not just its downstream event: an
  // event count alone could read as 0 simply because it was read too early.
  let completeCalls = 0;
  page.on('request', (request) => {
    if (request.url().indexOf('/api/complete-payment') !== -1) completeCalls += 1;
  });

  const mark = await mock.events.mark();
  await runPayment(page).click();

  // shims/hosted-fields.js:436-447 sets `fields.<key>.error.message = 'Required'`
  // for each empty card field; HostedFieldInput.tsx:50 surfaces it.
  await expect(page.getByText('Required', { exact: true })).toHaveCount(3);
  await expect(successHeading(page)).toHaveCount(0);
  // `submitFields` rejected, so `setLoading(false)` ran and the overlay
  // (PaymentForm.tsx:358-368) is gone — i.e. the submit is finished, not
  // in-flight, which is what makes the two zero-counts below meaningful.
  await expect(page.locator('.chakra-spinner')).toHaveCount(0);

  expect(completeCalls).toBe(0);

  // No /api/complete-payment call means no PaymentSessionComplete on the wire.
  expect(
    await mock.events.count({
      op: 'PaymentSessionComplete',
      firmId: connectedUser.firmId,
      since: mark,
    }),
  ).toBe(0);
  // Nothing was staged on the session either, so a later run of the same token
  // could not be completed off the back of this click.
  const token = await currentPaymentToken(page);
  expect((await mock.sessions.get(token)).used).toBe(false);

  // Filling the fields clears the message again, and a real submit then works.
  await fillCardFields(page, CARDS.visaSuccess);
  await expect(page.getByText('Required', { exact: true })).toHaveCount(0);
  const { status } = await runPaymentAndCaptureResponse(page, async () => {
    await runPayment(page).click();
  });
  expect(status).toBe(200);
  expect(completeCalls).toBe(1);
  await expect(successHeading(page)).toBeVisible();
});

test(
  'an unconnected user gets a bare 500 from /payment-intents',
  {
    annotation: {
      type: 'quirk',
      description:
        'payment-intents.tsx:22 casts a null Firm.glApiToken to string and passes it to ' +
        'createPaymentToken in getServerSideProps, which has no try/catch — so a logged-in but ' +
        'unconnected user gets Next’s generic 500 instead of being sent home to connect.',
    },
  },
  async ({ page, user }) => {
    expect(user.userId).toBeTruthy();
    const response = await page.goto('/payment-intents');
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(500);
    await expect(page.getByRole('heading', { name: 'Payment Intents' })).toHaveCount(0);
  },
);
