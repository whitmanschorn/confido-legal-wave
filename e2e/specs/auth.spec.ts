/**
 * auth.spec — sign up, login, logout and the logged-out route matrix.
 *
 * PLAN.md §6 "auth.spec". Two quirks are pinned here:
 *
 *  - QUIRKS #1: `POST /api/login` answers HTTP 200 with the body `403` for a
 *    wrong password (`src/pages/api/login.ts:32`), and `src/pages/login.tsx:35`
 *    navigates to `/` regardless of the response, which `requireAuth` then
 *    bounces to `/signup`. No error is shown anywhere.
 *  - QUIRKS #3: `/clients`, `/stored-payment-methods` and `/transactions` have
 *    no `requireAuth`, render HTTP 200 for a logged-out visitor, and then the
 *    client render throws in `src/components/layout/Sidebar.tsx:67`. This spec
 *    records exactly what the visitor ends up looking at:
 *
 *      status                200
 *      server-rendered body  an EMPTY `#__next` shell (Chakra global styles
 *                            only) — `SessionProvider.tsx:50` renders
 *                            `{loaded && props.children}`, so no page in this
 *                            app server-renders anything
 *      document.title        "Application error: a client-side exception has occurred"
 *      visible body text     "Application error: a client-side exception has
 *                            occurred (see the browser console for more
 *                            information)." — and nothing else at all
 *      console               "TypeError: Cannot read properties of undefined
 *                            (reading 'name') at Sidebar (…)", twice, plus
 *                            Next's client-side-exception doc link
 *      pageerror             none — React's boundary catches it
 *
 *    Same three routes, identical outcome. `/stored-payment-methods` also
 *    fires `GET /api/stored-payment-methods/create-token` from an unguarded
 *    mount effect on the way down, which answers 500 `{"error":"user not
 *    found"}` (its own test below).
 *
 * Local form helpers, not `signupViaUi` / `loginViaUi`: `getByLabel('Password')`
 * is ambiguous on both forms because `src/components/auth/PasswordField.tsx:35`
 * gives the reveal button `aria-label="Reveal password"`, and Playwright's
 * `getByLabel` is a case-insensitive substring match. `{ exact: true }` is
 * required. See the hand-back notes.
 */

import type { Page } from '@playwright/test';
import {
  expect,
  getSession,
  hasPathname,
  makeCredentials,
  signupViaApi,
  test,
} from '../fixtures/test';
import type { Credentials } from '../fixtures/test';

/** `/` and everything else wrapped in `requireAuth` (`src/lib/session.ts:117`). */
const GUARDED_ROUTES = ['/', '/payment-intents', '/paylinks'];

/** Pages that ship no `getServerSideProps` guard at all. */
const UNGUARDED_ROUTES = ['/clients', '/stored-payment-methods', '/transactions'];

/**
 * A same-origin request each unguarded route fires from a **mount effect**, and
 * therefore also fires for a logged-out visitor, before the render crashes.
 * `null` = the route only fetches `/api/session`.
 */
const UNGUARDED_MOUNT_CALLS: Record<string, string | null> = {
  '/clients': null,
  // `src/pages/stored-payment-methods.tsx:16` mounts CreateStoredPaymentMethodModal
  // unconditionally (`isOpen` only controls whether Chakra paints it), and
  // `useSavePaymentMethodToken.ts:22-24` fetches from a mount effect with no guard.
  '/stored-payment-methods': '/api/stored-payment-methods/create-token',
  '/transactions': null,
};

/** The text Next's production error boundary renders when a page render throws. */
const CLIENT_EXCEPTION_TEXT =
  'Application error: a client-side exception has occurred';

/** The whole visible page, verbatim — the crash leaves nothing else behind. */
const CLIENT_EXCEPTION_FULL_TEXT =
  'Application error: a client-side exception has occurred ' +
  '(see the browser console for more information).';

/** Next also overwrites `document.title` with the short form. */
const CLIENT_EXCEPTION_TITLE = 'Application error: a client-side exception has occurred';

/** The line Next's error boundary logs alongside the original TypeError. */
const NEXT_CLIENT_EXCEPTION_CONSOLE =
  'A client-side exception has occurred, see here for more info: ' +
  'https://nextjs.org/docs/messages/client-side-exception-occurred';

/**
 * Sidebar labels. None of them appear in the server response for any page,
 * because `src/components/layout/SessionProvider.tsx:50` renders
 * `{loaded && props.children}` and `loaded` only flips after the client-side
 * `GET /api/session` resolves — so every route in this app pre-renders an
 * empty `#__next` shell. See the quirk annotation below.
 */
const SIDEBAR_LABELS = ['Payment Intents', 'Stored Payment Methods', 'Clients'];

async function fillPassword(page: Page, value: string): Promise<void> {
  // `{ exact: true }` — see the file header.
  await page.getByLabel('Password', { exact: true }).fill(value);
}

async function submitSignupForm(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('Firm name').fill(credentials.firmName);
  await page.getByLabel('Username').fill(credentials.username);
  await fillPassword(page, credentials.password);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
}

async function submitLoginForm(
  page: Page,
  credentials: { username: string; password: string },
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(credentials.username);
  await fillPassword(page, credentials.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
}

async function waveUserIdCookie(
  context: { cookies: () => Promise<Array<{ name: string; value: string }>> },
): Promise<string | null> {
  const cookies = await context.cookies();
  const matches = cookies.filter((cookie) => cookie.name === 'wave:userId');
  return matches.length > 0 ? matches[0].value : null;
}

test.describe('sign up', () => {
  test('signing up through the UI lands on the connect splash and sets wave:userId', async ({
    page,
    context,
  }, testInfo) => {
    const credentials = makeCredentials(testInfo.workerIndex);

    await submitSignupForm(page, credentials);
    await page.waitForURL(hasPathname('/'));

    await expect(
      page.getByRole('heading', { name: "Let's get started 🚀" }),
    ).toBeVisible();

    const cookie = await waveUserIdCookie(context);
    expect(cookie, 'POST /api/signup must set the wave:userId cookie').not.toBeNull();

    const session = await getSession(context.request);
    expect(session.user?.username).toBe(credentials.username);
    expect(session.user?.id).toBe(cookie);
    expect(session.firm?.name).toBe(credentials.firmName);
    // NB: `session.firm.glApiToken` is deliberately NOT asserted null here.
    // Merely rendering `/` while unconnected creates a Confido firm and stores
    // its token — see the `createFirm on page load` quirk test in
    // home-signup-link.spec.
  });
});

test.describe('login', () => {
  test('the correct password logs in and lands on /', async ({ page, context }, testInfo) => {
    const credentials = makeCredentials(testInfo.workerIndex);
    await signupViaApi(context.request, credentials);
    await context.clearCookies();

    await submitLoginForm(page, credentials);
    await page.waitForURL(hasPathname('/'));

    await expect(
      page.getByRole('heading', { name: "Let's get started 🚀" }),
    ).toBeVisible();
    expect(await waveUserIdCookie(context)).not.toBeNull();
  });

  test(
    'a wrong password still navigates to /, which bounces to /signup',
    {
      annotation: {
        type: 'quirk',
        description:
          'QUIRKS #1: src/pages/api/login.ts:32 `res.send(403)` is HTTP 200 with the body "403", ' +
          'and src/pages/login.tsx:35 sets window.location.href = "/" for every response, ' +
          'so a wrong password silently redirects to /signup with no error shown.',
      },
    },
    async ({ page, context }, testInfo) => {
      const credentials = makeCredentials(testInfo.workerIndex);
      await signupViaApi(context.request, credentials);
      await context.clearCookies();

      // The route itself: HTTP 200 with "403" as the body.
      const apiResponse = await context.request.post('/api/login', {
        data: { username: credentials.username, password: 'not-the-password' },
      });
      expect(apiResponse.status()).toBe(200);
      expect(await apiResponse.text()).toBe('403');
      expect(
        await waveUserIdCookie(context),
        'a rejected login must not set a session cookie',
      ).toBeNull();

      // The page: navigates to `/` anyway, and requireAuth bounces to /signup.
      await submitLoginForm(page, {
        username: credentials.username,
        password: 'not-the-password',
      });
      await page.waitForURL(hasPathname('/signup'));

      await expect(
        page.getByRole('heading', { name: 'Sign up for a Legal Wave account' }),
      ).toBeVisible();
      // The whole point of the quirk: no error message anywhere in the flow.
      await expect(page.getByText(/invalid|incorrect|wrong|failed/i)).toHaveCount(0);
      expect(await waveUserIdCookie(context)).toBeNull();
    },
  );

  test(
    'a correct password also returns HTTP 200 with the body "200"',
    {
      annotation: {
        type: 'quirk',
        description:
          'QUIRKS #1: src/pages/api/login.ts:29 `res.send(200)` — success and failure are ' +
          'indistinguishable by status, only by body text.',
      },
    },
    async ({ context }, testInfo) => {
      const credentials = makeCredentials(testInfo.workerIndex);
      await signupViaApi(context.request, credentials);
      await context.clearCookies();

      const response = await context.request.post('/api/login', {
        data: { username: credentials.username, password: credentials.password },
      });
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe('200');
      expect(await waveUserIdCookie(context)).not.toBeNull();
    },
  );
});

test.describe('logout', () => {
  test('/logout redirects to /login and clears the cookie', async ({ page, context }, testInfo) => {
    const credentials = makeCredentials(testInfo.workerIndex);
    await signupViaApi(context.request, credentials);
    expect(await waveUserIdCookie(context)).not.toBeNull();

    await page.goto('/logout');
    await page.waitForURL(hasPathname('/login'));

    await expect(
      page.getByRole('heading', { name: 'Login to your Legal Wave account' }),
    ).toBeVisible();
    expect(await waveUserIdCookie(context)).toBeNull();

    // And the session really is gone server-side.
    const session = await getSession(context.request);
    expect(session).toEqual({});
  });
});

test.describe('logged-out route matrix', () => {
  GUARDED_ROUTES.forEach((route) => {
    test(`logged out ${route} redirects to /signup`, async ({ page, request }) => {
      // Server-side: requireAuth answers 307 with Location: /signup.
      const raw = await request.get(route, { maxRedirects: 0 });
      expect(raw.status()).toBe(307);
      expect(raw.headers()['location']).toBe('/signup');

      // In the browser: the visitor ends up on the signup form.
      await page.goto(route);
      await page.waitForURL(hasPathname('/signup'));
      await expect(
        page.getByRole('heading', { name: 'Sign up for a Legal Wave account' }),
      ).toBeVisible();
    });
  });

  UNGUARDED_ROUTES.forEach((route) => {
    const mountCallUrl = UNGUARDED_MOUNT_CALLS[route];

    test(
      `logged out ${route} returns 200 and then crashes in the browser`,
      {
        annotation: {
          type: 'quirk',
          description:
            `QUIRKS #3: ${route} has no requireAuth, so it serves HTTP 200 to a logged-out ` +
            'visitor. That 200 is an EMPTY static shell, not app markup — ' +
            'src/components/layout/SessionProvider.tsx:50 renders `{loaded && props.children}` ' +
            'and `loaded` only flips after the client-side GET /api/session resolves, so no ' +
            'page in this app ever server-renders content (`"nextExport":true`, `#__next` ' +
            'holds only Chakra global styles). GET /api/session then returns {}, and ' +
            'src/components/layout/Sidebar.tsx:67 dereferences `session.firm!.name`, which ' +
            'throws "TypeError: Cannot read properties of undefined (reading \'name\')" — ' +
            'reported as a CONSOLE error via React\'s error boundary, never as an uncaught ' +
            "page error. Next's production error boundary then replaces the whole document " +
            'with the single sentence "Application error: a client-side exception has ' +
            'occurred (see the browser console for more information)." and sets ' +
            'document.title to the same short form. What the user sees is a bare white page ' +
            'with that one line: no sidebar, no page content, no login prompt, and no hint ' +
            'that the real problem is that they are logged out. Verified in-browser (Phase 2).',
        },
      },
      async ({ page, request }) => {
        // No cookie => the session the client renders from is literally `{}`.
        const sessionResponse = await request.get('/api/session');
        expect(sessionResponse.status()).toBe(200);
        expect(await sessionResponse.json()).toEqual({});

        // The raw 200: an empty shell. Nothing of the app is server-rendered,
        // so "the HTML is fine" is really "the HTML is empty".
        const raw = await request.get(route);
        expect(raw.status()).toBe(200);
        const rawHtml = await raw.text();
        expect(rawHtml).toContain('id="__next"');
        SIDEBAR_LABELS.forEach((label) => {
          expect(rawHtml, `${route} must not server-render "${label}"`).not.toContain(label);
        });
        expect(rawHtml).not.toContain(CLIENT_EXCEPTION_TEXT);

        const consoleErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));

        // Mount effects run even though the render is about to blow up.
        const mountCall = mountCallUrl
          ? page.waitForResponse((response) => response.url().indexOf(mountCallUrl) !== -1)
          : null;

        // The server-rendered response is a perfectly ordinary 200.
        const response = await page.goto(route);
        expect(response, `no response for ${route}`).not.toBeNull();
        expect(response!.status()).toBe(200);
        expect(new URL(page.url()).pathname).toBe(route);

        // …and then the client render blows up.
        await expect(page.getByText(CLIENT_EXCEPTION_TEXT)).toBeVisible();

        // Exactly what the user is left looking at: one sentence, nothing else.
        await expect(page.locator('body')).toHaveText(CLIENT_EXCEPTION_FULL_TEXT);
        await expect(page).toHaveTitle(CLIENT_EXCEPTION_TITLE);

        // Nothing of the app is left: no sidebar, no page content.
        await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Add client' })).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Save New Payment Method' }),
        ).toHaveCount(0);
        // …and no hint that the fix is to log in.
        await expect(page.getByRole('link', { name: 'Login' })).toHaveCount(0);
        await expect(page.getByText(/log ?in|sign ?up|unauthori[sz]ed/i)).toHaveCount(0);

        const allErrors = consoleErrors.concat(pageErrors).join('\n');
        expect(
          allErrors,
          'expected the undefined-dereference from Sidebar in the console',
        ).toMatch(/Cannot read propert(?:y|ies) (?:'name' )?of undefined/);
        expect(allErrors).toContain('Sidebar');
        // React's boundary catches it, so it is logged, never thrown at the page.
        expect(consoleErrors.join('\n')).toContain(NEXT_CLIENT_EXCEPTION_CONSOLE);
        expect(pageErrors, 'the crash is caught by React, not an uncaught error').toEqual([]);

        if (mountCall) {
          // `/stored-payment-methods` also hits the API on the way down.
          const mountResponse = await mountCall;
          expect(mountResponse.status()).toBe(500);
          expect(await mountResponse.json()).toEqual({ error: 'user not found' });
        }
      },
    );
  });

  test(
    'logged out /stored-payment-methods calls create-token before it crashes',
    {
      annotation: {
        type: 'quirk',
        description:
          'The stored-payment-methods analogue of QUIRKS #15. ' +
          'src/pages/stored-payment-methods.tsx:16 renders <CreateStoredPaymentMethodModal> ' +
          'unconditionally — `isOpen` only controls whether Chakra paints the Modal — and ' +
          'src/components/stored-payment-methods/useSavePaymentMethodToken.ts:22-24 calls ' +
          'fetchAndSaveToken() from a mount effect with no `isOpen` guard. So GET ' +
          '/api/stored-payment-methods/create-token is issued on EVERY load of the page, ' +
          'including by a logged-out visitor who never opens the modal. For that visitor ' +
          'src/pages/api/stored-payment-methods/create-token.ts:10 throws in ' +
          'getSessionFromRequestOrThrow (src/lib/session.ts:67) and :19 echoes the raw ' +
          'message back as HTTP 500 {"error":"user not found"} — unlike QUIRKS #4, where the ' +
          'same throw is swallowed into a bare 500. For a logged-in connected firm the same ' +
          'unguarded mount effect means a real createSavePaymentMethodToken call to Confido ' +
          'on every page view.',
      },
    },
    async ({ page }) => {
      const createToken = page.waitForResponse((response) =>
        response.url().indexOf('/api/stored-payment-methods/create-token') !== -1,
      );
      await page.goto('/stored-payment-methods');

      const response = await createToken;
      expect(response.request().method()).toBe('GET');
      expect(response.status()).toBe(500);
      expect(await response.json()).toEqual({ error: 'user not found' });

      // The modal was never opened; nothing on screen ever asked for a token.
      await expect(page.getByText(CLIENT_EXCEPTION_TEXT)).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('Save a Payment Method')).toHaveCount(0);
    },
  );
});
