/**
 * The plain API routes (PLAN.md §6, `api-routes.spec`).
 *
 *   GET  /api/session
 *   POST /api/pay-request-lookup
 *   POST /api/disconnect
 *   POST /api/get-sign-up-link
 *   POST /api/onboarding/create-onboarding-code
 *
 * Request-only: no `page` is ever opened. Cookie-bearing calls go through
 * `context.request` (the `user` fixture signs up through it, so the
 * `wave:userId` cookie is already in that jar); cookie-less calls go through
 * the worker-scoped `request` fixture, which has its own empty jar.
 *
 * The connect step is done here with `context.request` rather than the
 * `connectedUser` fixture, because `connectedUser` drives `page.goto` and this
 * file is deliberately browser-free.
 */

import type { APIRequestContext, BrowserContext } from '@playwright/test';
import type { MockControl, WaveSession } from '../fixtures/test';
import { expect, getSession, test } from '../fixtures/test';

/** The mock's firm-token prefix (PLAN.md §0.1). Never a real credential. */
const MOCK_FIRM_TOKEN_PREFIX = 'f_secret_mock_';

interface Connection {
  firmId: string;
  firmName: string;
  firmToken: string;
}

/**
 * Mints a connect code on the mock and walks `GET /api/gravity-callback`
 * without a browser. `maxRedirects: 0` stops the 303 to `/` from turning this
 * into a full page fetch.
 */
async function connectFirm(
  context: BrowserContext,
  mock: MockControl,
): Promise<Connection> {
  const minted = await mock.connect.mint();
  const response = await context.request.get(
    `/api/gravity-callback?code=${encodeURIComponent(minted.code)}&state=e2e-state`,
    { maxRedirects: 0 },
  );
  expect(
    response.status(),
    `gravity-callback failed: ${await response.text()}`,
  ).toBe(303);
  return { firmId: minted.firmId, firmName: minted.firmName, firmToken: minted.firmToken };
}

async function payRequestLookup(
  request: APIRequestContext,
  externalId: string,
): Promise<{ status: number; text: string }> {
  const response = await request.post('/api/pay-request-lookup', {
    data: { externalId },
  });
  return { status: response.status(), text: await response.text() };
}

const SESSION_LEAK_QUIRK =
  'src/pages/api/session.ts:57 sends the whole Prisma User and Firm rows to the browser. ' +
  'User.password is stored in plaintext (prisma/schema.prisma, nothing hashes it) and ' +
  'Firm.glApiToken is the firm\'s Confido API secret, so GET /api/session hands both to ' +
  'anyone holding the session cookie. src/pages/clients.tsx:28 and ' +
  'src/components/clients/AddClient.tsx:58 then send that firm secret to Confido as ' +
  'x-api-key straight from the browser. QUIRKS.md #2.';

const SEND_NUMBER_QUIRK =
  'src/pages/api/disconnect.ts:16 returns res.send(200). NextApiResponse.send treats a ' +
  'number as the body, so the route answers HTTP 200 with the text `200` rather than ' +
  'setting a status. QUIRKS.md #1.';

const BARE_500_QUIRK =
  'src/lib/session.ts:67 throws new Error("user not found") and neither ' +
  'src/pages/api/get-sign-up-link.ts:11 nor ' +
  'src/pages/api/onboarding/create-onboarding-code.ts:11 catches it, so an unauthenticated ' +
  'call gets Next\'s generic 500 page instead of a 401. PLAN.md §6 predicted the body would ' +
  'say "user not found"; it does not — the message is swallowed and only the status is ' +
  'observable. QUIRKS.md #4.';

// ---------------------------------------------------------------------------
// GET /api/session
// ---------------------------------------------------------------------------

test.describe('GET /api/session', () => {
  test('with no cookie returns an empty object', async ({ request }) => {
    const response = await request.get('/api/session');

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({});
  });

  test('with a session cookie returns the user and the local firm', async ({
    context,
    user,
  }) => {
    const session: WaveSession = await getSession(context.request);

    expect(session.user).toBeTruthy();
    expect(session.user!.id).toBe(user.userId);
    expect(session.user!.username).toBe(user.username);

    expect(session.firm).toBeTruthy();
    expect(session.firm!.id).toBe(user.localFirmId);
    expect(session.firm!.name).toBe(user.firmName);

    // Not connected yet, so no Confido token and no Confido firm.
    expect(session.firm!.glApiToken).toBeNull();
    expect(session.glFirm).toBeUndefined();
    expect(session.error).toBeUndefined();
  });

  test('once connected it also returns glFirm, fetched live from Confido', async ({
    context,
    mock,
    user,
  }) => {
    const mark = await mock.events.mark();
    const connection = await connectFirm(context, mock);

    // The exchange really did go to Confido with the partner token.
    const exchange = await mock.events.waitFor({
      op: 'ExchangedCodeForFirmToken',
      since: mark,
    });
    expect(exchange.tokenKind).toBe('partner');
    expect(exchange.ok).toBe(true);

    const session: WaveSession = await getSession(context.request);

    expect(session.user!.id).toBe(user.userId);
    expect(session.firm!.glApiToken).toBe(connection.firmToken);
    expect(session.glFirm).toEqual({
      id: connection.firmId,
      name: connection.firmName,
      isAcceptingPayments: true,
    });

    // `glFirm` is not read out of the DB — session.ts:44 calls getFirm() on
    // every request with the stored token.
    const getFirmEvent = await mock.events.waitFor({
      op: 'GetFirm',
      firmId: connection.firmId,
      since: mark,
    });
    expect(getFirmEvent.tokenKind).toBe('firm');
  });

  test(
    'leaks the user\'s plaintext password and the firm\'s Confido secret to the browser',
    { annotation: { type: 'quirk', description: SESSION_LEAK_QUIRK } },
    async ({ context, mock, user }) => {
      const connection = await connectFirm(context, mock);

      // Read the raw text, not just the parsed object, so the assertion is
      // unambiguous about what crosses the wire.
      const response = await context.request.get('/api/session');
      const text = await response.text();
      const session = JSON.parse(text) as WaveSession;

      // 1. The password, in the clear, exactly as it was submitted to /api/signup.
      expect(session.user!.password).toBe(user.password);
      expect(text).toContain(`"password":"${user.password}"`);

      // 2. The firm's Confido API secret — a server-side credential.
      expect(session.firm!.glApiToken).toBe(connection.firmToken);
      expect(session.firm!.glApiToken!.indexOf(MOCK_FIRM_TOKEN_PREFIX)).toBe(0);
      expect(text).toContain(connection.firmToken);
    },
  );

  test('recovers when Confido revokes the firm token behind the app\'s back', async ({
    context,
    mock,
    user,
  }) => {
    const connection = await connectFirm(context, mock);

    // ---- before: a live token and a live glFirm -----------------------------
    const before: WaveSession = await getSession(context.request);
    expect(before.firm!.glApiToken).toBe(connection.firmToken);
    expect(before.glFirm).toEqual({
      id: connection.firmId,
      name: connection.firmName,
      isAcceptingPayments: true,
    });

    // Out-of-band revocation — what `disconnectFromPartner` does on Confido's
    // side, or an operator revoking the token in the portal.
    await mock.firms.revokeTokens(connection.firmId);
    const revokedAt = await mock.events.mark();

    // ---- the transition itself ---------------------------------------------
    const after: WaveSession = await getSession(context.request);

    // The app really did try the stored token and really was refused: the mock
    // records the pre-execution failure the live API returns for a revoked
    // token (PLAN.md §0.1), scoped to this test's own firm.
    const refused = await mock.events.waitFor({
      op: 'GetFirm',
      firmId: connection.firmId,
      since: revokedAt,
    });
    expect(refused.ok).toBe(false);
    expect(refused.tokenKind).toBe('revoked');
    expect(refused.errorMessage).toContain('Token has been revoked');

    // src/pages/api/session.ts:44-53 catches that failure and writes
    // glApiToken: null back to the DB, so the home page falls back to the
    // connect splash instead of erroring.
    expect(after.firm!.glApiToken).toBeNull();
    expect(after.glFirm).toBeUndefined();
    expect(after.user!.id).toBe(user.userId);
    expect(after.firm!.id).toBe(user.localFirmId);

    // ---- after: persisted, and the dead token is never presented again ------
    const settledAt = await mock.events.mark();
    const again: WaveSession = await getSession(context.request);
    expect(again.firm!.glApiToken).toBeNull();
    expect(again.glFirm).toBeUndefined();

    // `if (firm?.glApiToken)` is now false, so this third request must not have
    // called Confido at all. Scoped to this firm id, so a parallel worker's
    // traffic cannot make it pass or fail. The response above has already
    // returned, so any call it made is in the log by now.
    const afterSettled = await mock.events.list({
      op: 'GetFirm',
      firmId: connection.firmId,
      since: settledAt,
    });
    expect(afterSettled).toEqual([]);
  });

  test('a cookie for a user that no longer exists answers 401 with the Prisma error', async ({
    request,
  }) => {
    const response = await request.get('/api/session', {
      headers: { cookie: 'wave:userId=no-such-user-id' },
    });

    // session.ts:59-61 — the catch turns findUniqueOrThrow into a 401 whose
    // body is the raw Prisma message.
    expect(response.status()).toBe(401);
    const body = (await response.json()) as WaveSession;
    expect(body.error).toContain('prisma.user.findUniqueOrThrow()');
    expect(body.user).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/pay-request-lookup
// ---------------------------------------------------------------------------

test.describe('POST /api/pay-request-lookup', () => {
  test('an unconnected firm gets 400 `Firm not connected`', async ({ context, user }) => {
    const result = await payRequestLookup(
      context.request,
      '11111111-1111-1111-1111-111111111111',
    );

    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      error: 'Firm not connected',
      details: 'Please connect your firm first',
    });
    // The 400 is the "no glApiToken" branch (pay-request-lookup.ts:16-21), not
    // the "glFirm missing" one (`:23-28`), which has a different message.
    const session: WaveSession = await getSession(context.request);
    expect(session.firm!.id).toBe(user.localFirmId);
    expect(session.firm!.glApiToken).toBeNull();
  });

  test('a connected firm gets 200 and an empty list for an unknown externalId', async ({
    context,
    mock,
    user,
  }) => {
    const connection = await connectFirm(context, mock);
    const mark = await mock.events.mark();

    const externalId = '22222222-2222-2222-2222-222222222222';
    const result = await payRequestLookup(context.request, externalId);

    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ payRequestList: [] });

    // The lookup really reached Confido, scoped to this firm.
    const event = await mock.events.waitFor({
      op: 'PayRequestList',
      firmId: connection.firmId,
      since: mark,
    });
    expect(event.variables).toEqual({
      input: { externalId, firmId: connection.firmId },
    });
  });

  test(
    'without a cookie it is a bare 500, like the other session-throwing routes',
    { annotation: { type: 'quirk', description: BARE_500_QUIRK } },
    async ({ request }) => {
      // getFullSessionFromRequestOrThrow → getSessionFromRequestOrThrow →
      // throw new Error('user not found'), uncaught.
      const result = await payRequestLookup(request, 'anything');

      expect(result.status).toBe(500);
      // Next's generic page: the thrown message never reaches the caller, so
      // an unauthenticated call is indistinguishable from a server fault.
      expect(result.text.trim()).toBe('Internal Server Error');
      expect(result.text).not.toContain('user not found');
    },
  );
});

// ---------------------------------------------------------------------------
// POST /api/disconnect
// ---------------------------------------------------------------------------

test.describe('POST /api/disconnect', () => {
  test(
    'with no firm connected it answers HTTP 200 with the body `200`',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ context, user }) => {
      const before: WaveSession = await getSession(context.request);
      expect(before.firm!.glApiToken).toBeNull();

      const response = await context.request.post('/api/disconnect');

      expect(response.status()).toBe(200);
      expect((await response.text()).trim()).toBe('200');

      // disconnect.ts:14-17 returns before touching Confido, so nothing about
      // the session changed. (That no Confido call happened is asserted by the
      // next test, which has a real Confido firm id to scope the event query
      // to; this user has none, and an unscoped "no events" query would be a
      // lie in a suite that shares one mock across workers.)
      const after: WaveSession = await getSession(context.request);
      expect(after.firm!.id).toBe(user.localFirmId);
      expect(after.firm!.glApiToken).toBeNull();
      expect(after.glFirm).toBeUndefined();
    },
  );

  test(
    'a second disconnect really does skip Confido rather than calling it again',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ context, mock, user }) => {
      // `user` is what puts the wave:userId cookie in this context's jar; the
      // callback 500s without it.
      const connection = await connectFirm(context, mock);
      expect(user.localFirmId).toBeTruthy();

      // First disconnect: the real one.
      const firstMark = await mock.events.mark();
      const first = await context.request.post('/api/disconnect');
      expect((await first.text()).trim()).toBe('200');
      const disconnected = await mock.events.waitFor({
        op: 'DisconnectFromPartner',
        firmId: connection.firmId,
        since: firstMark,
      });
      expect(disconnected.ok).toBe(true);

      // Second disconnect: the token is gone locally, so `if (!firmToken)`
      // short-circuits and Confido must not be called for THIS firm again.
      // Scoped by the Confido firm id, so this is a real assertion rather than
      // a filter that could never match.
      const secondMark = await mock.events.mark();
      const second = await context.request.post('/api/disconnect');
      expect(second.status()).toBe(200);
      expect((await second.text()).trim()).toBe('200');

      const repeats = await mock.events.list({
        op: 'DisconnectFromPartner',
        firmId: connection.firmId,
        since: secondMark,
      });
      expect(repeats).toEqual([]);
    },
  );

  test(
    'with a firm connected it revokes the token and still answers with the body `200`',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ context, mock, user }) => {
      const connection = await connectFirm(context, mock);
      const mark = await mock.events.mark();

      const response = await context.request.post('/api/disconnect');

      expect(response.status()).toBe(200);
      expect((await response.text()).trim()).toBe('200');

      const event = await mock.events.waitFor({
        op: 'DisconnectFromPartner',
        firmId: connection.firmId,
        since: mark,
      });
      expect(event.ok).toBe(true);

      // disconnect.ts:23-30 nulls the token locally too.
      const session: WaveSession = await getSession(context.request);
      expect(session.firm!.id).toBe(user.localFirmId);
      expect(session.firm!.glApiToken).toBeNull();
      expect(session.glFirm).toBeUndefined();
    },
  );

  test(
    'without a cookie it is a bare 500',
    { annotation: { type: 'quirk', description: BARE_500_QUIRK } },
    async ({ request }) => {
      const response = await request.post('/api/disconnect');

      expect(response.status()).toBe(500);
      const text = await response.text();
      expect(text.trim()).toBe('Internal Server Error');
      expect(text).not.toContain('user not found');
    },
  );
});

// ---------------------------------------------------------------------------
// The two onboarding routes, unauthenticated
// ---------------------------------------------------------------------------

test.describe('routes that throw out of getSessionFromRequestOrThrow', () => {
  test(
    'POST /api/get-sign-up-link without a cookie is 500 `Internal Server Error`',
    { annotation: { type: 'quirk', description: BARE_500_QUIRK } },
    async ({ request }) => {
      const response = await request.post('/api/get-sign-up-link', { data: {} });

      expect(response.status()).toBe(500);
      // Not `user not found`, and not a 401 either.
      expect((await response.text()).trim()).toBe('Internal Server Error');
    },
  );

  test(
    'POST /api/onboarding/create-onboarding-code without a cookie is 500 `Internal Server Error`',
    { annotation: { type: 'quirk', description: BARE_500_QUIRK } },
    async ({ request }) => {
      const response = await request.post('/api/onboarding/create-onboarding-code', {
        data: {},
      });

      expect(response.status()).toBe(500);
      expect((await response.text()).trim()).toBe('Internal Server Error');
    },
  );
});
