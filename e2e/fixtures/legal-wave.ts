/**
 * Small, composable helpers for driving Legal Wave itself (PLAN.md §6).
 *
 * Everything here is a plain function over a `Page` or an `APIRequestContext`,
 * so specs can use them with or without the extended `test` fixtures.
 *
 * All selectors are roles/labels — the app ships no `data-testid` and we do not
 * add any (PLAN.md §8.6). The only `data-testid`s in play belong to the shims.
 */

import type { APIRequestContext, Locator, Page, Response } from '@playwright/test';
import { expect } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import { LEGACY_WEBHOOK_SECRET, WEBHOOK_SECRET } from '../playwright.config';
import type { TestBankAccount, TestCard } from './cards';

// ---------------------------------------------------------------------------
// Shapes the app's own routes return
// ---------------------------------------------------------------------------

/** `prisma.User`, as `POST /api/signup` and `GET /api/session` return it. */
export interface WaveUser {
  id: string;
  username: string;
  /** Yes, plaintext, and yes, it is sent to the browser. See QUIRKS. */
  password: string;
  firmId: string;
  createdAt: string;
  updatedAt: string;
}

/** `prisma.Firm`. `glApiToken` is the Confido firm secret — also sent to the browser. */
export interface WaveFirm {
  id: string;
  name: string;
  glApiToken: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `ConfidoLegalFirm` from `src/confido-legal-requests/getFirm.ts`. */
export interface WaveGlFirm {
  id: string;
  name: string;
  isAcceptingPayments: boolean;
}

/** `GET /api/session`. Everything is optional; a cookie-less request returns `{}`. */
export interface WaveSession {
  user?: WaveUser;
  firm?: WaveFirm;
  glFirm?: WaveGlFirm;
  error?: string;
}

/** `POST /api/get-sign-up-link` — a spread of `createFirmSignUpLink`. */
export interface WaveSignUpLink {
  link: string;
  expiresAt: string;
}

export interface Credentials {
  username: string;
  password: string;
  firmName: string;
}

// ---------------------------------------------------------------------------
// Hosted-field plumbing (the shim's inputs, see PLAN.md §4.1)
// ---------------------------------------------------------------------------

/**
 * The six field keys `useConfidoLegal.ts` passes to `gravityLegal.init`, mapped
 * to the container ids the app renders. The shim appends
 * `input[data-testid="hf-<key>"]` inside each container.
 */
export const HOSTED_FIELD_CONTAINERS = {
  cardNumber: 'card-number',
  cardExpirationDate: 'card-exp',
  cardSecurityCode: 'card-cvv',
  accountHolderName: 'account-holder-name',
  accountNumber: 'account-number',
  routingNumber: 'routing-number',
} as const;

export type HostedFieldKey = keyof typeof HOSTED_FIELD_CONTAINERS;

export const CARD_FIELD_KEYS: HostedFieldKey[] = [
  'cardNumber',
  'cardExpirationDate',
  'cardSecurityCode',
];

export const ACH_FIELD_KEYS: HostedFieldKey[] = [
  'accountHolderName',
  'accountNumber',
  'routingNumber',
];

/** Locator for one shim-rendered hosted field. */
export function hostedField(page: Page, key: HostedFieldKey): Locator {
  return page.getByTestId(`hf-${key}`);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A username no other test can collide with. Tests are isolated by minting a
 * fresh user, never by resetting the database (PLAN.md §0, DB row).
 */
export function uniqueUsername(workerIndex: number): string {
  return `u_${workerIndex}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function makeCredentials(workerIndex: number): Credentials {
  const username = uniqueUsername(workerIndex);
  return {
    username,
    password: 'pw',
    firmName: `Firm ${username}`,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * `POST /api/signup`. Use the *context's* request object so the `wave:userId`
 * cookie lands in the browser context and the page is logged in.
 */
export async function signupViaApi(
  request: APIRequestContext,
  credentials: Credentials,
): Promise<WaveUser> {
  const response = await request.post('/api/signup', {
    data: {
      username: credentials.username,
      password: credentials.password,
      firmName: credentials.firmName,
    },
  });
  expect(
    response.status(),
    `POST /api/signup failed: ${await response.text()}`,
  ).toBe(200);
  return (await response.json()) as WaveUser;
}

/** Fills and submits the `/signup` form, then waits for the landing on `/`. */
export async function signupViaUi(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('Firm name').fill(credentials.firmName);
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.waitForURL(hasPathname('/'));
}

/**
 * Fills and submits the `/login` form. The page navigates to `/` on *any*
 * response, including the 200-with-body-`403` failure case, so callers that
 * test a bad password should pass `{ expectLanding: false }` and assert
 * themselves.
 */
export async function loginViaUi(
  page: Page,
  credentials: Pick<Credentials, 'username' | 'password'>,
  options: { expectLanding?: boolean } = {},
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  if (options.expectLanding !== false) {
    await page.waitForURL(hasPathname('/'));
  }
}

/** `/logout` clears the cookie and bounces to `/login`. */
export async function logoutViaUi(page: Page): Promise<void> {
  await page.goto('/logout');
  await page.waitForURL(hasPathname('/login'));
}

/** `GET /api/session` as JSON. */
export async function getSession(request: APIRequestContext): Promise<WaveSession> {
  const response = await request.get('/api/session');
  return (await response.json()) as WaveSession;
}

/** `POST /api/get-sign-up-link` — creates the Confido firm on first call. */
export async function getSignUpLink(request: APIRequestContext): Promise<WaveSignUpLink> {
  const response = await request.post('/api/get-sign-up-link', { data: {} });
  expect(
    response.status(),
    `POST /api/get-sign-up-link failed: ${await response.text()}`,
  ).toBe(200);
  return (await response.json()) as WaveSignUpLink;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/**
 * Drives `GET /api/gravity-callback?code=…&state=…`, which exchanges the code
 * with the partner token and 303s to `/`.
 *
 * Deliberately does not assert: reusing a code makes this route throw, and
 * `home-connect.spec` needs to observe that.
 */
export async function connectViaCallback(
  page: Page,
  code: string,
  options: { state?: string } = {},
): Promise<Response | null> {
  const state = options.state ?? 'e2e-state';
  return page.goto(
    `/api/gravity-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
}

/** The `s_code` out of a sign-up link, or `null` if the link has no query form. */
export function signUpCodeFromLink(link: string): string | null {
  try {
    return new URL(link).searchParams.get('s_code');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** Types a card into the shim's three card fields. */
export async function fillCardFields(page: Page, card: TestCard): Promise<void> {
  await hostedField(page, 'cardNumber').fill(card.number);
  await hostedField(page, 'cardExpirationDate').fill(card.exp);
  await hostedField(page, 'cardSecurityCode').fill(card.cvv);
}

/** Types a bank account into the shim's three ACH fields. */
export async function fillAchFields(page: Page, account: TestBankAccount): Promise<void> {
  await hostedField(page, 'accountHolderName').fill(account.accountHolderName);
  await hostedField(page, 'routingNumber').fill(account.routingNumber);
  await hostedField(page, 'accountNumber').fill(account.accountNumber);
}

/** Waits for every hosted field to have been rendered by the shim. */
export async function waitForHostedFields(
  page: Page,
  keys: HostedFieldKey[] = Object.keys(HOSTED_FIELD_CONTAINERS) as HostedFieldKey[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += 1) {
    await expect(hostedField(page, keys[i])).toBeAttached();
  }
}

/**
 * Runs `action` and resolves with the `POST /api/complete-payment` response
 * body. Never sleeps.
 */
export async function runPaymentAndCaptureResponse(
  page: Page,
  action: () => Promise<void>,
): Promise<{ status: number; body: unknown }> {
  const waiter = page.waitForResponse('**/api/complete-payment');
  await action();
  const response = await waiter;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = await response.text();
  }
  return { status: response.status(), body };
}

/** Same, for the Stored Payment Methods flow. */
export async function savePaymentMethodAndCaptureResponse(
  page: Page,
  action: () => Promise<void>,
): Promise<{ status: number; body: unknown }> {
  const waiter = page.waitForResponse('**/api/stored-payment-methods/complete');
  await action();
  const response = await waiter;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = await response.text();
  }
  return { status: response.status(), body };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * `HMAC-SHA512(base64)` over `JSON.stringify(body)`, exactly as
 * `src/pages/api/accept-webhook.ts` recomputes it.
 */
export function signWebhookBody(body: unknown, secret: string): string {
  const hmac = createHmac('sha512', secret);
  hmac.update(JSON.stringify(body));
  return hmac.digest('base64');
}

/** Header + signature for `POST /api/accept-webhook`. */
export function webhookHeaders(body: unknown): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-signature': signWebhookBody(body, WEBHOOK_SECRET),
  };
}

/** Header + signature for `POST /api/legacy-accept-webhook`. */
export function legacyWebhookHeaders(body: unknown): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-prahari-signature': signWebhookBody(body, LEGACY_WEBHOOK_SECRET),
  };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Predicate for `page.waitForURL`, ignoring query and hash. */
export function hasPathname(pathname: string): (url: URL) => boolean {
  return (url: URL) => url.pathname === pathname;
}
