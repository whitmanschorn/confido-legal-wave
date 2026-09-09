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
 *    records exactly what the visitor ends up looking at.
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

/** The text Next's production error boundary renders when a page render throws. */
const CLIENT_EXCEPTION_TEXT =
  'Application error: a client-side exception has occurred';

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
    test(
      `logged out ${route} returns 200 and then crashes in the browser`,
      {
        annotation: {
          type: 'quirk',
          description:
            `QUIRKS #3: ${route} has no requireAuth, so it serves HTTP 200 to a logged-out ` +
            'visitor. GET /api/session then returns {}, and ' +
            'src/components/layout/Sidebar.tsx:67 dereferences `session.firm!.name`, which ' +
            'throws "Cannot read properties of undefined (reading \'name\')". React unmounts ' +
            'the tree and Next\'s production error boundary replaces the whole page with ' +
            '"Application error: a client-side exception has occurred (see the browser ' +
            'console for more information)." Verified in-browser (Phase 2).',
        },
      },
      async ({ page, request }) => {
        // No cookie => the session the client renders from is literally `{}`.
        const sessionResponse = await request.get('/api/session');
        expect(sessionResponse.status()).toBe(200);
        expect(await sessionResponse.json()).toEqual({});

        const consoleErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));

        // The server-rendered response is a perfectly ordinary 200.
        const response = await page.goto(route);
        expect(response, `no response for ${route}`).not.toBeNull();
        expect(response!.status()).toBe(200);
        expect(new URL(page.url()).pathname).toBe(route);

        // …and then the client render blows up.
        await expect(page.getByText(CLIENT_EXCEPTION_TEXT)).toBeVisible();

        // Nothing of the app is left: no sidebar, no page content.
        await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Add client' })).toHaveCount(0);

        const allErrors = consoleErrors.concat(pageErrors).join('\n');
        expect(
          allErrors,
          'expected the undefined-dereference from Sidebar in the console',
        ).toMatch(/Cannot read propert(?:y|ies) (?:'name' )?of undefined/);
        expect(allErrors).toContain('Sidebar');
      },
    );
  });
});
