/**
 * Control API + fake Confido app pages (PLAN.md §3.4 and §3.5).
 *
 * Owned by unit C. `server.ts` routes everything that is not /healthz, not the
 * root index page and not GraphQL to `handleControl`, so the 404 for unknown
 * paths lives here too.
 *
 * Rules this file obeys (PLAN.md §0.0): the repo-root tsconfig type-checks it
 * under `target: es5` with no `downlevelIteration`, so there is no iterator
 * spread, no `for…of` over a Map/Set, no `for await`, and every relative
 * import is extensionless. The runtime is `tsx` in CommonJS mode, so shim
 * files are located with `__dirname`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as store from './store';
import { eventCount, queryEvents, resetEvents } from './events';
import type {
  FirmStatus,
  FormType,
  PaymentSessionMethod,
  StagedInstrument,
} from './types';
import {
  appIndexPage,
  connectPage,
  iframeTargetPage,
  notFoundPage,
  signupPage,
} from './fake-app/pages';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Every response carries CORS headers: the browser shims call the control API
 * cross-origin from http://127.0.0.1:7001.
 */
function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-api-key, x-requested-with',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
  };
}

function withHeaders(extra: Record<string, string>): Record<string, string> {
  const headers = corsHeaders();
  const keys = Object.keys(extra);
  for (let i = 0; i < keys.length; i += 1) headers[keys[i]] = extra[keys[i]];
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, withHeaders({ 'content-type': 'application/json; charset=utf-8' }));
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, withHeaders({ 'content-type': 'text/html; charset=utf-8' }));
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, withHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
  res.end(text);
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, withHeaders({ location, 'content-type': 'text/plain; charset=utf-8' }));
  res.end(`Redirecting to ${location}`);
}

function notFound(res: ServerResponse, message: string): void {
  sendJson(res, 404, { error: 'not found', message });
}

function methodNotAllowed(res: ServerResponse, allowed: string): void {
  res.writeHead(
    405,
    withHeaders({ allow: allowed, 'content-type': 'application/json; charset=utf-8' }),
  );
  res.end(JSON.stringify({ error: 'method not allowed', allow: allowed }));
}

/**
 * Read the whole request body. Deliberately a data/end listener promise rather
 * than `for await (const chunk of req)`: `for await` does not compile under the
 * repo-root tsconfig (PLAN.md §0.0).
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

type Json = Record<string, unknown>;

/** Accepts JSON (the fixtures and shims) and form-urlencoded (the fake pages). */
async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const raw = await readBody(req);
  if (!raw) return {};

  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.indexOf('application/x-www-form-urlencoded') !== -1) {
    const params = new URLSearchParams(raw);
    const out: Json = {};
    params.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
    return { value: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw badRequest(`invalid JSON body: ${message}`);
  }
}

/**
 * A 400 marked on the error object rather than by subclass: `class X extends
 * Error` breaks `instanceof` when downlevelled, and this file is compiled by
 * two different toolchains (PLAN.md §0.0).
 */
interface ControlError extends Error {
  controlStatus?: number;
}

function badRequest(message: string): Error {
  const error = new Error(message) as ControlError;
  error.controlStatus = 400;
  return error;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (isFinite(parsed)) return parsed;
  }
  return undefined;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    return segment;
  }
}

function segmentsOf(pathname: string): string[] {
  const parts = pathname.split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] !== '') out.push(decode(parts[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point (frozen interface, called by server.ts)
// ---------------------------------------------------------------------------

export async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', store.MOCK_ORIGIN);
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Preflight: answer for every path, the browser never sees a 404 preflight.
  if (method === 'OPTIONS') {
    res.writeHead(204, withHeaders({ 'content-length': '0' }));
    res.end();
    return;
  }

  const segments = segmentsOf(pathname);

  try {
    if (segments[0] === '__control') {
      await handleControlApi(req, res, method, segments.slice(1), url);
      return;
    }
    if (segments[0] === 'app') {
      await handleFakeApp(req, res, method, segments.slice(1), url);
      return;
    }
    if (segments[0] === 'js' && segments.length === 2) {
      await handleShim(res, method, segments[1]);
      return;
    }
    if (segments.length === 1 && segments[0] === 'iframe-target') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
      sendHtml(res, 200, iframeTargetPage());
      return;
    }
    if (segments.length === 1 && segments[0] === 'favicon.ico') {
      // Answered explicitly so it never shows up as an "escaped request".
      res.writeHead(204, withHeaders({ 'content-length': '0' }));
      res.end();
      return;
    }

    notFound(res, `no mock route for ${method} ${pathname}`);
  } catch (error) {
    const status = error instanceof Error ? (error as ControlError).controlStatus : undefined;
    if (status === 400) {
      sendJson(res, 400, { error: 'bad request', message: (error as Error).message });
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// §3.4 Control API
// ---------------------------------------------------------------------------

async function handleControlApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rest: string[],
  url: URL,
): Promise<void> {
  const head = rest[0];

  // POST /__control/reset
  if (head === 'reset' && rest.length === 1) {
    if (method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
    store.reset();
    resetEvents();
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /__control/state
  if (head === 'state' && rest.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
    sendJson(res, 200, store.stateDump(eventCount()));
    return;
  }

  // GET /__control/events?since=&op=&firmId=
  if (head === 'events' && rest.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
    const since = num(url.searchParams.get('since'));
    const op = url.searchParams.get('op');
    const firmId = url.searchParams.get('firmId');
    sendJson(
      res,
      200,
      queryEvents({
        since,
        op: op === null || op === '' ? undefined : op,
        firmId: firmId === null || firmId === '' ? undefined : firmId,
      }),
    );
    return;
  }

  if (head === 'firms') {
    // GET /__control/firms/by-token/:token
    if (rest[1] === 'by-token' && rest.length === 3) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
      const firm = store.findFirmByToken(rest[2]);
      if (!firm) return notFound(res, `no firm holds token ${rest[2]}`);
      sendJson(res, 200, store.firmView(firm));
      return;
    }

    // GET /__control/firms  (not in §3.4; handy and harmless)
    if (rest.length === 1) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
      sendJson(res, 200, { firms: store.listFirms().map(store.firmView) });
      return;
    }

    // POST /__control/firms/:id/<action>
    if (rest.length === 3) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
      const firmId = rest[1];
      const action = rest[2];

      if (action === 'activate') {
        const firm = store.activateFirm(firmId);
        if (!firm) return notFound(res, `no firm ${firmId}`);
        sendJson(res, 200, store.firmView(firm));
        return;
      }

      if (action === 'deactivate') {
        const firm = store.deactivateFirm(firmId);
        if (!firm) return notFound(res, `no firm ${firmId}`);
        sendJson(res, 200, store.firmView(firm));
        return;
      }

      if (action === 'surcharging') {
        const body = await readJsonBody(req);
        const enabled = bool(body.enabled);
        if (enabled === undefined) {
          throw badRequest('body must be { enabled: boolean, rate?: number }');
        }
        const rate = num(body.rate);
        const firm = store.setSurcharging(
          firmId,
          enabled,
          rate === undefined ? store.DEFAULT_SURCHARGE_RATE : rate,
        );
        if (!firm) return notFound(res, `no firm ${firmId}`);
        sendJson(res, 200, store.firmView(firm));
        return;
      }

      if (action === 'revoke-tokens') {
        if (!store.getFirm(firmId)) return notFound(res, `no firm ${firmId}`);
        store.revokeFirmTokens(firmId);
        const firm = store.getFirm(firmId);
        if (!firm) return notFound(res, `no firm ${firmId}`);
        sendJson(res, 200, store.firmView(firm));
        return;
      }

      if (action === 'status') {
        // Not in §3.4; lets a spec park a firm in APP_IN_REVIEW etc.
        const body = await readJsonBody(req);
        const status = str(body.status);
        if (!status) throw badRequest('body must be { status: FirmStatus }');
        const firm = store.setFirmStatus(firmId, status as FirmStatus);
        if (!firm) return notFound(res, `no firm ${firmId}`);
        sendJson(res, 200, store.firmView(firm));
        return;
      }

      return notFound(res, `unknown firm action ${action}`);
    }
  }

  // POST /__control/connect/mint  { name? } → MintedConnect
  if (head === 'connect' && rest[1] === 'mint' && rest.length === 2) {
    if (method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
    const body = await readJsonBody(req);
    const name = str(body.name);
    const firm = store.createFirm({ name, active: true });
    const firmToken = store.issueFirmToken(firm.id);
    const code = store.createConnectCode(firm.id);
    sendJson(res, 200, {
      firmId: firm.id,
      firmName: firm.name,
      code: code.code,
      firmToken,
    });
    return;
  }

  if (head === 'sessions') {
    // GET /__control/sessions/:token → SessionView | 404
    if (rest.length === 2) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
      const session = store.getSession(rest[1]);
      if (!session) return notFound(res, `no session ${rest[1]}`);
      sendJson(res, 200, store.sessionView(session));
      return;
    }

    // POST /__control/sessions/:token/stage → SessionView | 404
    if (rest.length === 3 && rest[2] === 'stage') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
      const token = rest[1];
      if (!store.getSession(token)) return notFound(res, `no session ${token}`);
      const body = await readJsonBody(req);
      const session = store.stageInstrument(token, toStagedInstrument(body));
      if (!session) return notFound(res, `no session ${token}`);
      sendJson(res, 200, store.sessionView(session));
      return;
    }
  }

  // POST /__control/onboarding/:token/submit → firm moves to APP_SUBMITTED
  if (head === 'onboarding' && rest.length === 3 && rest[2] === 'submit') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
    const record = store.submitOnboarding(rest[1]);
    if (!record) return notFound(res, `no onboarding token ${rest[1]}`);
    const firm = store.getFirm(record.firmId);
    if (!firm) return notFound(res, `no firm ${record.firmId}`);
    sendJson(res, 200, store.firmView(firm));
    return;
  }

  // POST /__control/paylinks/seed  { firmId, id, totalAmount } → PaymentLinkRecord
  // Payment links are firm-scoped: seeding one firm's link leaves every other
  // firm still seeing "Paylink not found", which is what keeps paylinks.spec's
  // two halves from racing (PLAN.md §3.4).
  if (head === 'paylinks' && rest[1] === 'seed' && rest.length === 2) {
    if (method !== 'POST') return methodNotAllowed(res, 'POST, OPTIONS');
    const body = await readJsonBody(req);
    const id = str(body.id);
    const firmId = str(body.firmId);
    if (!id || !firmId) {
      throw badRequest('body must be { firmId: string, id: string, totalAmount?: number }');
    }
    if (!store.getFirm(firmId)) throw badRequest(`unknown firm ${firmId}`);
    const totalAmount = num(body.totalAmount);
    sendJson(
      res,
      200,
      store.seedPaylink(
        firmId,
        id,
        totalAmount === undefined ? store.DEFAULT_PAYLINK_TOTAL_AMOUNT : totalAmount,
      ),
    );
    return;
  }

  notFound(res, `no control route for ${method} /__control/${rest.join('/')}`);
}

/** Normalise whatever the hosted-fields shim staged into a StagedInstrument. */
function toStagedInstrument(body: Json): StagedInstrument {
  const rawForm = str(body.form);
  const form: FormType = rawForm === 'ach' ? 'ach' : 'card';

  const rawMethod = (str(body.paymentMethod) ?? '').toUpperCase();
  let paymentMethod: PaymentSessionMethod;
  if (form === 'ach') {
    paymentMethod = 'ACH';
  } else if (rawMethod === 'DEBIT') {
    paymentMethod = 'DEBIT';
  } else {
    paymentMethod = 'CREDIT';
  }

  const instrument: StagedInstrument = { form, paymentMethod };

  const cardNumber = str(body.cardNumber);
  if (cardNumber !== undefined) instrument.cardNumber = cardNumber;
  const cardExpirationDate = str(body.cardExpirationDate);
  if (cardExpirationDate !== undefined) instrument.cardExpirationDate = cardExpirationDate;
  const cardSecurityCode = str(body.cardSecurityCode);
  if (cardSecurityCode !== undefined) instrument.cardSecurityCode = cardSecurityCode;
  const cardBrand = str(body.cardBrand);
  if (cardBrand !== undefined) instrument.cardBrand = cardBrand;
  const accountNumber = str(body.accountNumber);
  if (accountNumber !== undefined) instrument.accountNumber = accountNumber;
  const routingNumber = str(body.routingNumber);
  if (routingNumber !== undefined) instrument.routingNumber = routingNumber;
  const accountHolderName = str(body.accountHolderName);
  if (accountHolderName !== undefined) instrument.accountHolderName = accountHolderName;

  const lastFour = str(body.lastFour);
  if (lastFour !== undefined) {
    instrument.lastFour = lastFour;
  } else {
    const source = form === 'ach' ? instrument.accountNumber : instrument.cardNumber;
    if (source && source.length >= 4) instrument.lastFour = source.slice(-4);
  }

  return instrument;
}

// ---------------------------------------------------------------------------
// §3.5 Fake Confido app pages
// ---------------------------------------------------------------------------

async function handleFakeApp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rest: string[],
  url: URL,
): Promise<void> {
  // GET /app
  if (rest.length === 0) {
    if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
    sendHtml(res, 200, appIndexPage());
    return;
  }

  // /app/connect/:appId?state=
  if (rest[0] === 'connect' && rest.length === 2) {
    const appId = rest[1];

    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const action = `/app/connect/${encodeURIComponent(appId)}?state=${encodeURIComponent(state)}`;
      sendHtml(res, 200, connectPage({ appId, state, action }));
      return;
    }

    if (method === 'POST') {
      const body = await readJsonBody(req);
      const state = str(body.state) ?? url.searchParams.get('state') ?? '';

      // Connect firms start ACTIVE (PLAN.md §0, row 6).
      const firm = store.createFirm({ name: nextConnectedFirmName(), active: true });
      store.issueFirmToken(firm.id);
      const code = store.createConnectCode(firm.id);

      // The real flow uses a callback URL registered in the partner portal;
      // the mock hardcodes it via store.CALLBACK_URL.
      const location =
        `${store.CALLBACK_URL}?code=${encodeURIComponent(code.code)}` +
        `&state=${encodeURIComponent(state)}`;
      sendRedirect(res, location);
      return;
    }

    return methodNotAllowed(res, 'GET, POST, OPTIONS');
  }

  // /app/signup?s_code=<code>  and  /app/signup/<code>
  if (rest[0] === 'signup' && (rest.length === 1 || rest.length === 2)) {
    if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
    const code =
      rest.length === 2 ? rest[1] : url.searchParams.get('s_code') ?? '';
    if (!code) {
      sendHtml(res, 404, notFoundPage('No sign-up code: expected ?s_code=<code>.'));
      return;
    }
    const link = store.getSignUpLink(code);
    if (!link) {
      sendHtml(res, 404, notFoundPage(`Unknown sign-up code ${code}.`));
      return;
    }
    const firm = store.getFirm(link.firmId);
    sendHtml(
      res,
      200,
      signupPage({ code, firmName: firm ? firm.name : `firm ${link.firmId}` }),
    );
    return;
  }

  sendHtml(res, 404, notFoundPage(`No mock app page for ${method} ${url.pathname}.`));
}

/**
 * `Connected Firm <n>`, with n derived from the store so it resets with it —
 * this module keeps no state of its own.
 */
function nextConnectedFirmName(): string {
  let n = 0;
  const firms = store.listFirms();
  for (let i = 0; i < firms.length; i += 1) {
    if (firms[i].name.indexOf('Connected Firm ') === 0) n += 1;
  }
  return `Connected Firm ${n + 1}`;
}

// ---------------------------------------------------------------------------
// Browser SDK shims, served from e2e/shims (owned by unit H)
// ---------------------------------------------------------------------------

/** __dirname, not import.meta.url: the runtime is tsx in CommonJS mode. */
const SHIM_DIR = join(__dirname, '..', 'shims');

const SHIMS: Record<string, string> = {
  'hosted-fields.js': 'hosted-fields.js',
  'onboarding.js': 'onboarding.js',
};

async function handleShim(res: ServerResponse, method: string, name: string): Promise<void> {
  if (method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');

  const file = SHIMS[name];
  if (!file) return notFound(res, `unknown shim /js/${name}`);

  const path = join(SHIM_DIR, file);
  let source: string;
  try {
    // Read per request, never cached: editing a shim only needs a page reload.
    source = await readFile(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendText(
      res,
      404,
      `Shim not found: ${path}\n` +
        `The mock server serves e2e/shims/${file} at /js/${name}; that file does not exist yet.\n` +
        message,
    );
    return;
  }

  res.writeHead(
    200,
    withHeaders({ 'content-type': 'application/javascript; charset=utf-8' }),
  );
  res.end(source);
}
