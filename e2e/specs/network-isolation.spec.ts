/**
 * The headline proof (PLAN.md §6, `network-isolation.spec`): a complete
 * signup → connect → payment → client journey runs with **no** credentials and
 * **nothing** reaching the public internet.
 *
 * `test.use({ strictNetworkIsolation: true })` puts the `lockdown` fixture into
 * its strictest mode: every off-box request counts as an offence, images and
 * fonts included, not just the `document`/`script`/`xhr`/`fetch` set that fails
 * a normal test. Everything here is counted by `lockdown`'s route handler —
 * there is no timing, no sleep and no "it probably didn't happen".
 *
 * Two categories of non-loopback traffic exist and both are accounted for:
 *
 * 1. **Forwarded.** `src/confido-legal-requests/index.ts` inlines the sandbox
 *    URL into the *client* bundle, and the Clients page calls Confido straight
 *    from the browser (`src/components/clients/AddClient.tsx:58`). The lockdown
 *    fixture rewrites that one origin to the mock. This is the only permitted
 *    non-loopback call, and the test pins it to exactly one request whose reply
 *    demonstrably came from the mock (there is a matching `AddClient` event in
 *    the mock's ring buffer).
 *
 * 2. **Aborted.** `src/components/layout/Sidebar.tsx:68` hardcodes an off-box
 *    avatar, `https://tinyurl.com/yhkm2ek8`, rendered by every authenticated
 *    page; the unmodified Chakra transactions template
 *    (`src/components/transactions/TransactionsTable.tsx:28-68`) hardcodes five
 *    more on `bit.ly`. They are aborted, never fetched. The test asserts the
 *    complete contents of `lockdown.escaped` — every entry, its URL, method and
 *    resource type — rather than a bare count, so a regression that added any
 *    other off-box call would fail here even if it were also an image.
 *
 * Once every recorded escape has been individually accounted for, the
 * already-explained third-party avatars are removed from `lockdown.escaped` so
 * the fixture's teardown guard (which cannot tell "asserted" from "unnoticed")
 * does not re-report them — anything *not* on the allow-list is deliberately
 * left in place, so the guard stays armed.
 */

import type { EscapedRequest } from '../fixtures/test';
import {
  CARDS,
  MOCK,
  SANDBOX_GRAPHQL_URL,
  expect,
  fillCardFields,
  getSession,
  makeCredentials,
  test,
  waitForHostedFields,
} from '../fixtures/test';

/** `src/components/layout/Sidebar.tsx:68` — on every authenticated page. */
const SIDEBAR_AVATAR_URL = 'https://tinyurl.com/yhkm2ek8';

/** The five `src/components/transactions/TransactionsTable.tsx` avatars. */
const TEMPLATE_AVATAR_URLS = [
  'https://bit.ly/code-beast',
  'https://bit.ly/kent-c-dodds',
  'https://bit.ly/prosper-baba',
  'https://bit.ly/ryan-florence',
  'https://bit.ly/sage-adebayo',
];

/**
 * The complete set of off-box URLs the app is *known* to request. Anything
 * outside this list escaping is a regression, in any resource type.
 */
const KNOWN_THIRD_PARTY_AVATARS: string[] = [SIDEBAR_AVATAR_URL].concat(
  TEMPLATE_AVATAR_URLS,
);

function isKnownThirdPartyAvatar(record: EscapedRequest): boolean {
  return (
    record.resourceType === 'image' &&
    record.method === 'GET' &&
    KNOWN_THIRD_PARTY_AVATARS.indexOf(record.url) !== -1
  );
}

/** Distinct values, in first-seen order. No Set spread — root tsconfig is ES5. */
function distinct(values: string[]): string[] {
  const out: string[] = [];
  values.forEach((value) => {
    if (out.indexOf(value) === -1) out.push(value);
  });
  return out;
}

// ---------------------------------------------------------------------------
// The full journey, under the strictest lockdown available
// ---------------------------------------------------------------------------

test.describe('strict network isolation', () => {
  test.use({ strictNetworkIsolation: true });

  test('signup → connect → payment → client runs entirely on loopback', async ({
    page,
    mock,
    lockdown,
  }, testInfo) => {
    expect(
      lockdown.isStrict(),
      'test.use({ strictNetworkIsolation: true }) must be in effect',
    ).toBe(true);

    // ---- 1. Sign up through the UI, no API shortcut -----------------------
    const credentials = makeCredentials(testInfo.workerIndex);
    await page.goto('/signup');
    await page.getByLabel('Firm name').fill(credentials.firmName);
    await page.getByLabel('Username').fill(credentials.username);
    // NB: `getByLabel('Password')` is a strict-mode violation on this form —
    // Chakra's "Reveal password" button carries the same accessible name.
    await page.getByRole('textbox', { name: 'Password' }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.getByRole('heading', { name: "Let's get started 🚀" })).toBeVisible();

    // ---- 2. Connect, through the real popup flow --------------------------
    const connectLink = page.getByRole('link', { name: /\/connect\// });
    await expect(connectLink).toHaveAttribute(
      'href',
      new RegExp(`^${MOCK.replace(/\./g, '\\.')}/app/connect/`),
    );

    const connectMark = await mock.events.mark();
    const popupPromise = page.waitForEvent('popup');
    await connectLink.click();
    const popup = await popupPromise;

    await expect(popup.getByRole('heading', { name: 'Authorize Legal Wave' })).toBeVisible();
    await popup.getByRole('button', { name: 'Authorize' }).click();
    // The mock 302s to /api/gravity-callback, which 303s to the app's home page.
    await popup.waitForURL((url) => url.pathname === '/');
    await popup.close();

    const exchange = await mock.events.waitFor({
      op: 'ExchangedCodeForFirmToken',
      since: connectMark,
    });
    expect(exchange.ok).toBe(true);
    // The exchange runs on the partner token, so the event carries no firm
    // scope yet; the Confido firm id arrives with the next /api/session.
    expect(exchange.tokenKind).toBe('partner');

    await page.reload();
    await expect(page.getByText('Connected to Confido Legal \u2705')).toBeVisible();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();

    const session = await getSession(page.request);
    const firmId = session.glFirm!.id;
    expect(firmId).toBeTruthy();
    expect(session.glFirm!.isAcceptingPayments).toBe(true);

    // ---- 3. Take a card payment -------------------------------------------
    await page.goto('/payment-intents');
    await waitForHostedFields(page);

    const paymentMark = await mock.events.mark();
    await page.getByLabel('Amount').fill('10.00');
    await page.locator('#name').fill('Isolation Payer');
    await page.locator('#email').fill('isolation@example.test');
    await fillCardFields(page, CARDS.visaSuccess);
    await page.getByRole('button', { name: 'Run payment' }).click();

    await expect(page.getByRole('heading', { name: 'Success!' })).toBeVisible();
    const completed = await mock.events.waitFor({
      op: 'PaymentSessionComplete',
      firmId,
      since: paymentMark,
    });
    expect(completed.ok).toBe(true);

    // ---- 4. The one browser-side Confido call ------------------------------
    await page.goto('/clients');
    const clientMark = await mock.events.mark();
    await page.getByRole('button', { name: 'Add client' }).click();
    await page.getByLabel('Client Name').fill('Isolation Client');
    await page.getByRole('button', { name: 'Add Client', exact: true }).click();
    await expect(page.getByText('Added client')).toBeVisible();

    // The request left the page addressed to the public sandbox URL and was
    // answered by the mock. Both halves matter, so assert both.
    await lockdown.waitForForwards(1);
    const addClientEvent = await mock.events.waitFor({
      op: 'AddClient',
      firmId,
      since: clientMark,
    });
    expect(addClientEvent.ok).toBe(true);

    // ---- 5. Account for every byte that was not loopback -------------------

    // 5a. Forwarded: exactly the one browser-side Confido call, nothing else.
    expect(lockdown.forwarded).toEqual([
      { url: SANDBOX_GRAPHQL_URL, method: 'POST', status: 200 },
    ]);

    // 5b. Escaped: every entry is one of the app's hardcoded third-party
    // avatars, aborted before it could leave the machine. Asserting the whole
    // list (not `length === 0`, and not `length === n`) is what makes this
    // catch a regression: a new off-box call of any kind lands here.
    const escaped = lockdown.escaped.slice();
    const unexpected = escaped.filter((record) => !isKnownThirdPartyAvatar(record));
    expect(
      unexpected,
      'requests tried to leave the box that are not the app\'s known third-party avatars',
    ).toEqual([]);

    // The journey visits four authenticated pages, so the sidebar avatar is
    // requested — and blocked — at least once. If it stopped being requested,
    // this assertion tells us the app changed rather than silently passing.
    expect(escaped.length).toBeGreaterThan(0);
    expect(distinct(escaped.map((record) => record.url))).toEqual([SIDEBAR_AVATAR_URL]);
    expect(distinct(escaped.map((record) => record.resourceType))).toEqual(['image']);

    // 5c. Nothing that could carry a credential or execute code got out. This
    // is the assertion that would fail loudest if the suite ever started
    // talking to the real Confido.
    const sensitive = escaped.filter(
      (record) =>
        record.url.indexOf('gravity-legal.com') !== -1 ||
        record.url.indexOf('confidolegal.com') !== -1,
    );
    expect(sensitive).toEqual([]);

    // 5d. In strict mode the avatars *are* offences — proof the guard is armed
    // more tightly than the default, where images are tolerated.
    expect(lockdown.offendingEscapes().length).toBe(escaped.length);

    // Every escape above has now been asserted individually. Drop only those
    // from the fixture's buffer so its teardown guard does not re-report the
    // already-explained avatars; anything else stays, and still fails the test.
    for (let i = lockdown.escaped.length - 1; i >= 0; i -= 1) {
      if (isKnownThirdPartyAvatar(lockdown.escaped[i])) {
        lockdown.escaped.splice(i, 1);
      }
    }
    // The splice removed only entries the allow-list matched exactly (see the
    // `the escape allow-list is exact` test below for the predicate's own
    // proof), and it removed all of them.
    expect(lockdown.escaped.filter(isKnownThirdPartyAvatar)).toEqual([]);
    expect(lockdown.offendingEscapes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guard is not vacuous
// ---------------------------------------------------------------------------

test.describe('the lockdown guard itself', () => {
  test('records and aborts off-box traffic, and strict mode escalates images', async ({
    page,
    lockdown,
  }) => {
    // Start from an app-origin page with no sidebar, so the only escapes in
    // this test are the ones it makes on purpose.
    await page.goto('/login');
    expect(lockdown.escapedCount()).toBe(0);

    // A fetch (a "blocking" resource type) and an image (tolerated by default).
    await page.evaluate(() => {
      window.fetch('https://escape-probe.invalid/exfiltrate').catch(() => undefined);
      const img = new Image();
      img.src = 'https://escape-probe.invalid/avatar.png';
    });

    await expect
      .poll(() => lockdown.escapedCount(), {
        message: 'waiting for both probe requests to be intercepted',
      })
      .toBe(2);

    const urls = lockdown.escaped.map((record) => record.url);
    expect(urls).toContain('https://escape-probe.invalid/exfiltrate');
    expect(urls).toContain('https://escape-probe.invalid/avatar.png');

    // Neither reached the network: they were aborted, so nothing was forwarded.
    expect(lockdown.forwardCount()).toBe(0);

    // Default mode: only the fetch is an offence.
    expect(lockdown.isStrict()).toBe(false);
    const normalOffenders = lockdown.offendingEscapes();
    expect(normalOffenders.length).toBe(1);
    expect(normalOffenders[0].url).toBe('https://escape-probe.invalid/exfiltrate');

    // Strict mode: the image is an offence too. This is exactly the escalation
    // the journey test above relies on.
    lockdown.setStrict(true);
    expect(lockdown.offendingEscapes().length).toBe(2);
    lockdown.setStrict(false);

    // These escapes were manufactured by the test; drop them so the teardown
    // guard has nothing left to report.
    lockdown.clear();
    expect(lockdown.offendingEscapes()).toEqual([]);
  });

  test('the escape allow-list is exact, so the teardown-guard splice cannot hide a real escape', () => {
    // The journey test removes already-asserted avatars from `lockdown.escaped`
    // before teardown. That is only safe if the predicate deciding what to
    // remove matches whole URLs and nothing else — so exercise it directly.
    const avatar: EscapedRequest = {
      url: SIDEBAR_AVATAR_URL,
      method: 'GET',
      resourceType: 'image',
    };
    expect(isKnownThirdPartyAvatar(avatar)).toBe(true);

    // Near misses, each of which a substring or prefix match would wave through.
    expect(
      isKnownThirdPartyAvatar({ ...avatar, url: `${SIDEBAR_AVATAR_URL}?token=leaked` }),
    ).toBe(false);
    expect(
      isKnownThirdPartyAvatar({ ...avatar, url: `https://evil.example/${SIDEBAR_AVATAR_URL}` }),
    ).toBe(false);
    expect(isKnownThirdPartyAvatar({ ...avatar, url: 'https://tinyurl.com/' })).toBe(false);
    // Same URL, but exfiltrating rather than fetching an image.
    expect(isKnownThirdPartyAvatar({ ...avatar, method: 'POST' })).toBe(false);
    expect(isKnownThirdPartyAvatar({ ...avatar, resourceType: 'fetch' })).toBe(false);
    // And the one origin that must never be waved through under any type.
    expect(
      isKnownThirdPartyAvatar({ ...avatar, url: `${SANDBOX_GRAPHQL_URL}/whatever` }),
    ).toBe(false);
  });

  test('the one permitted non-loopback origin is answered by the mock, not by Confido', async ({
    page,
    mock,
    lockdown,
  }) => {
    // The mirror image of the abort probe above: the *forwarded* branch needs a
    // positive control too, or "no escapes" could just mean "the request went
    // to the real sandbox and nobody noticed".
    await page.goto('/login');
    expect(lockdown.forwardCount()).toBe(0);

    const mark = await mock.events.mark();
    const probe = await page.evaluate(async (url: string) => {
      // Same shape as src/components/clients/AddClient.tsx:58 — a browser fetch
      // to the sandbox URL inlined in the client bundle, with an x-api-key
      // header, so it is CORS-preflighted exactly like the real one.
      const response = await window.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'p_secret_mock_partner',
        },
        body: JSON.stringify({
          // Deliberately not one of the app's 14 operation names, so the event
          // this produces can only be this test's and never a parallel
          // worker's home page.
          operationName: 'LockdownForwardProbe',
          query: 'query LockdownForwardProbe { me { partner { id appId } } }',
        }),
      });
      return { status: response.status, text: await response.text() };
    }, SANDBOX_GRAPHQL_URL);

    // Only the mock knows this partner: the real sandbox would reject the token.
    expect(probe.status).toBe(200);
    const payload = JSON.parse(probe.text) as {
      data?: { me?: { partner?: { id?: string; appId?: string } } };
    };
    expect(payload.data!.me!.partner!.appId).toBe('mock-app');

    const event = await mock.events.waitFor({ op: 'LockdownForwardProbe', since: mark });
    expect(event.tokenKind).toBe('partner');
    expect(event.ok).toBe(true);

    // Recorded as a forward, not as an escape, and it really was rewritten.
    expect(lockdown.forwarded).toEqual([
      { url: SANDBOX_GRAPHQL_URL, method: 'POST', status: 200 },
    ]);
    expect(lockdown.escaped).toEqual([]);
  });
});
