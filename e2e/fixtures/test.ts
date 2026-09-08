/**
 * The extended `test` every spec imports (PLAN.md §5).
 *
 *   import { test, expect } from '../fixtures/test';
 *
 * Fixtures:
 *   lockdown          (auto) proves the suite is credential- and network-free
 *   shims             (auto) injects the two browser SDK shims before any nav
 *   mock              typed client for the mock server's control API
 *   user              a freshly signed-up Legal Wave user, cookie already set
 *   connectedUser     `user` + a Confido firm connected through the OAuth callback
 *   pendingFirmUser   `user` + a Confido firm that is NOT accepting payments
 *
 * The fixture names and return types are a frozen contract with the spec files.
 */

import { expect as pwExpect, test as base } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, MOCK, SANDBOX_GRAPHQL_URL, MOCK_GRAPHQL_URL } from '../playwright.config';
import { MockControl } from './mock-client';
import type { WaveUser } from './legal-wave';
import {
  getSignUpLink,
  getSession,
  makeCredentials,
  signUpCodeFromLink,
  signupViaApi,
} from './legal-wave';

export { expect } from '@playwright/test';
export * from './mock-client';
export * from './legal-wave';
export * from './cards';

// ---------------------------------------------------------------------------
// lockdown
// ---------------------------------------------------------------------------

/** A request the browser tried to send off-box and that was aborted. */
export interface EscapedRequest {
  url: string;
  method: string;
  /** Playwright resource type: `document`, `script`, `xhr`, `fetch`, `image`, … */
  resourceType: string;
}

/** A request to the inlined sandbox URL that was rewritten to the mock instead. */
export interface ForwardedRequest {
  url: string;
  method: string;
  status: number;
}

/**
 * Resource types that always fail the test when they escape. Images and fonts
 * (the Chakra template's `bit.ly` avatars, the `tinyurl` profile image in
 * `src/components/layout/Sidebar.tsx`) abort silently unless strict mode is on.
 */
export const BLOCKING_RESOURCE_TYPES: string[] = [
  'document',
  'script',
  'xhr',
  'fetch',
  'websocket',
  'eventsource',
];

export interface LockdownController {
  /** Every aborted off-box request, in order. */
  readonly escaped: EscapedRequest[];
  /** Every sandbox-URL request that was forwarded to the mock, in order. */
  readonly forwarded: ForwardedRequest[];
  /** `forwarded.length`. */
  forwardCount(): number;
  /** `escaped.length`. */
  escapedCount(): number;
  /** The escapes that will fail the test at teardown, given the current mode. */
  offendingEscapes(): EscapedRequest[];
  /** Polls until at least `min` sandbox requests have been forwarded. */
  waitForForwards(min?: number, options?: { timeout?: number }): Promise<void>;
  /** Turn "any escape at all, including images, fails" on or off at runtime. */
  setStrict(strict: boolean): void;
  isStrict(): boolean;
  /** Drops the recorded history (not the routes). */
  clear(): void;
}

/** Test-level options, settable with `test.use({ strictNetworkIsolation: true })`. */
export interface LockdownOptions {
  /**
   * When true, *any* escaped request fails the test — images and fonts
   * included. `network-isolation.spec` runs the whole happy path this way.
   */
  strictNetworkIsolation: boolean;
}

// ---------------------------------------------------------------------------
// shims
// ---------------------------------------------------------------------------

export interface ShimsInfo {
  /** The value written to `window.__CONFIDO_MOCK_URL` before any page script runs. */
  mockUrl: string;
  /** Absolute paths of the shim files that were injected, in injection order. */
  files: string[];
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export interface TestUser {
  username: string;
  /** Always `'pw'`; the app stores it in plaintext. */
  password: string;
  /** The Legal Wave firm name, `Firm u_<worker>_<rand>`. */
  firmName: string;
  /** `prisma.User.id`, i.e. the value of the `wave:userId` cookie. */
  userId: string;
  /** `prisma.Firm.id` in Legal Wave's own SQLite DB — NOT the Confido firm id. */
  localFirmId: string;
  /** The raw `POST /api/signup` response. */
  raw: WaveUser;
}

export interface ConnectedUser extends TestUser {
  /** The Confido (mock) firm id — what `glFirm.id` shows. */
  firmId: string;
  /** The Confido (mock) firm name, e.g. `Connected Firm 3`. */
  confidoFirmName: string;
  /** The `f_secret_mock_…` token now stored in `Firm.glApiToken`. */
  firmToken: string;
  /** The one-time connect code that was exchanged. Reusing it is a quirk test. */
  connectCode: string;
}

export interface PendingFirmUser extends TestUser {
  /** The Confido (mock) firm id — created by `createFirm(mockOnboarding:false)`. */
  firmId: string;
  /** The `f_secret_mock_…` token stored in `Firm.glApiToken`. */
  firmToken: string;
  /** The sign-up link `POST /api/get-sign-up-link` returned. */
  signUpLink: string;
  /** The `s_code` query param from that link, if present. */
  signUpCode: string | null;
}

// ---------------------------------------------------------------------------
// Fixture wiring
// ---------------------------------------------------------------------------

export interface LegalWaveFixtures extends LockdownOptions {
  lockdown: LockdownController;
  shims: ShimsInfo;
  mock: MockControl;
  user: TestUser;
  connectedUser: ConnectedUser;
  pendingFirmUser: PendingFirmUser;
}

const SHIM_DIR = join(__dirname, '..', 'shims');
const SHIM_FILES = [
  join(SHIM_DIR, 'hosted-fields.js'),
  join(SHIM_DIR, 'onboarding.js'),
];

const shimSourceCache: Record<string, string> = {};

function readShim(path: string): string {
  const cached = shimSourceCache[path];
  if (cached !== undefined) return cached;
  if (!existsSync(path)) {
    throw new Error(
      `Shim file not found: ${path}\n` +
        'The browser SDK shims (e2e/shims/*.js) must exist before the `shims` ' +
        'fixture can inject them. See PLAN.md §4.',
    );
  }
  const source = readFileSync(path, 'utf8');
  shimSourceCache[path] = source;
  return source;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-api-key,authorization',
  'access-control-max-age': '600',
};

export const test = base.extend<LegalWaveFixtures>({
  strictNetworkIsolation: [false, { option: true }],

  lockdown: [
    async ({ context, strictNetworkIsolation }, use, testInfo) => {
      const escaped: EscapedRequest[] = [];
      const forwarded: ForwardedRequest[] = [];
      let strict = strictNetworkIsolation;

      // Everything that is not 127.0.0.1 or localhost is intercepted. The mock
      // (7002) and the app (7001) are therefore never touched by this route.
      await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async (route) => {
        const request = route.request();
        const url = request.url();
        const method = request.method();

        if (url.indexOf(SANDBOX_GRAPHQL_URL) === 0) {
          // The Clients page calls Confido straight from the browser with the
          // sandbox fallback URL inlined into the bundle. Forward it to the
          // mock rather than aborting it — this is the one allowed exception.
          if (method === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: CORS_HEADERS });
            return;
          }
          const response = await route.fetch({ url: MOCK_GRAPHQL_URL });
          const body = await response.text();
          const contentType = response.headers()['content-type'] ?? 'application/json';
          forwarded.push({ url, method, status: response.status() });
          await route.fulfill({
            status: response.status(),
            headers: Object.assign({ 'content-type': contentType }, CORS_HEADERS),
            body,
          });
          return;
        }

        escaped.push({ url, method, resourceType: request.resourceType() });
        await route.abort();
      });

      const offending = (): EscapedRequest[] =>
        strict
          ? escaped.slice()
          : escaped.filter((r) => BLOCKING_RESOURCE_TYPES.indexOf(r.resourceType) !== -1);

      const controller: LockdownController = {
        escaped,
        forwarded,
        forwardCount: () => forwarded.length,
        escapedCount: () => escaped.length,
        offendingEscapes: offending,
        waitForForwards: async (min = 1, options = {}) => {
          await pwExpect
            .poll(() => forwarded.length, {
              timeout: options.timeout ?? 15_000,
              message: `Waiting for ${min} forwarded request(s) to ${SANDBOX_GRAPHQL_URL}`,
            })
            .toBeGreaterThanOrEqual(min);
        },
        setStrict: (value: boolean) => {
          strict = value;
        },
        isStrict: () => strict,
        clear: () => {
          escaped.length = 0;
          forwarded.length = 0;
        },
      };

      await use(controller);

      if (escaped.length > 0) {
        await testInfo.attach('lockdown-escaped.json', {
          contentType: 'application/json',
          body: JSON.stringify(escaped, null, 2),
        });
      }

      const offenders = offending();
      // Only raise when the test would otherwise pass, so a real failure is
      // never masked by the teardown assertion. The attachment above records
      // the escapes either way.
      if (offenders.length > 0 && testInfo.status === testInfo.expectedStatus) {
        const lines = offenders.map((r) => `  ${r.resourceType} ${r.method} ${r.url}`);
        throw new Error(
          `Network lockdown violated${strict ? ' (strict mode)' : ''}: ` +
            `${offenders.length} request(s) tried to leave the box:\n${lines.join('\n')}`,
        );
      }
    },
    { auto: true },
  ],

  shims: [
    async ({ context }, use) => {
      // Set the mock URL first, then evaluate both shims — as init scripts, so
      // they can never lose the race with the app's `<script async>` tags.
      await context.addInitScript({
        content: `window.__CONFIDO_MOCK_URL = ${JSON.stringify(MOCK)};`,
      });
      const files: string[] = [];
      for (let i = 0; i < SHIM_FILES.length; i += 1) {
        const path = SHIM_FILES[i];
        await context.addInitScript({ content: readShim(path) });
        files.push(path);
      }
      await use({ mockUrl: MOCK, files });
    },
    { auto: true },
  ],

  mock: async ({ request }, use) => {
    await use(new MockControl(request, MOCK));
  },

  user: async ({ context }, use, testInfo) => {
    const credentials = makeCredentials(testInfo.workerIndex);
    // context.request, so the `wave:userId` cookie lands in the browser context.
    const raw = await signupViaApi(context.request, credentials);
    await use({
      username: credentials.username,
      password: credentials.password,
      firmName: credentials.firmName,
      userId: raw.id,
      localFirmId: raw.firmId,
      raw,
    });
  },

  connectedUser: async ({ context, page, user, mock }, use) => {
    const minted = await mock.connect.mint();
    const response = await page.goto(
      `/api/gravity-callback?code=${encodeURIComponent(minted.code)}&state=e2e-state`,
    );
    if (!response || response.status() >= 400) {
      throw new Error(
        `gravity-callback failed with ${response ? response.status() : 'no response'}`,
      );
    }
    const landed = new URL(page.url());
    if (landed.pathname !== '/') {
      throw new Error(`Expected the connect callback to land on /, got ${page.url()}`);
    }
    const session = await getSession(context.request);
    const firmToken = session.firm?.glApiToken ?? minted.firmToken;
    await use({
      username: user.username,
      password: user.password,
      firmName: user.firmName,
      userId: user.userId,
      localFirmId: user.localFirmId,
      raw: user.raw,
      firmId: minted.firmId,
      confidoFirmName: minted.firmName,
      firmToken,
      connectCode: minted.code,
    });
  },

  pendingFirmUser: async ({ context, user, mock }, use) => {
    // Creates the Confido firm with mockOnboarding:false, i.e. CREATED and not
    // accepting payments, and stores its token on the local firm row.
    const link = await getSignUpLink(context.request);
    const session = await getSession(context.request);
    const firmToken = session.firm?.glApiToken;
    if (!firmToken) {
      throw new Error('Expected /api/get-sign-up-link to store a firm token on the firm');
    }
    const firm = await mock.firms.byToken(firmToken);
    await use({
      username: user.username,
      password: user.password,
      firmName: user.firmName,
      userId: user.userId,
      localFirmId: user.localFirmId,
      raw: user.raw,
      firmId: firm.id,
      firmToken,
      signUpLink: link.link,
      signUpCode: signUpCodeFromLink(link.link),
    });
  },
});

export { APP, MOCK, MOCK_GRAPHQL_URL, SANDBOX_GRAPHQL_URL };
