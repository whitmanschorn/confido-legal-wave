/**
 * Typed client for the mock server's control API (`/__control/*`, PLAN.md §3.4).
 *
 * Every response shape is imported from `mock-server/types.ts`, which is the
 * frozen contract between unit C (which serves these routes) and the specs.
 * Nothing here invents a shape.
 *
 * The polling helpers (`mock.events.waitFor`, `lockdown`-free `expect.poll`
 * wrappers) exist so no spec ever needs `page.waitForTimeout`.
 */

import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { MOCK } from '../playwright.config';
import type {
  ClientRecord,
  EventsResponse,
  FirmStatus,
  FirmView,
  MintedConnect,
  MockEvent,
  PaymentLinkRecord,
  PaymentRecord,
  SessionView,
  SpmRecord,
  StagedInstrument,
  StateDump,
} from '../mock-server/types';

export type {
  ClientRecord,
  EventsResponse,
  FirmStatus,
  FirmView,
  MintedConnect,
  MockEvent,
  PaymentLinkRecord,
  PaymentRecord,
  SessionView,
  SpmRecord,
  StagedInstrument,
  StateDump,
};

/**
 * The payment-link id `src/pages/paylinks.tsx:24` hardcodes. Against the real
 * sandbox it belongs to the app author's account and 500s for everyone else
 * (PLAN.md §0.1); against the mock it 500s too until a test seeds it with
 * `mock.paylinks.seedPaylinksPage(connectedUser.firmId, 25000)`.
 */
export const PAYLINKS_PAGE_PAYMENT_LINK_ID = 'a1e7a82e-b59e-4645-b559-22e12bfb265c';

/** Default poll budget for the `waitFor*` helpers, in ms. */
const DEFAULT_WAIT_TIMEOUT = 15_000;

export interface ControlError extends Error {
  status?: number;
  bodyText?: string;
}

/** Low-level HTTP for the control API. Absolute URLs, so `baseURL` is irrelevant. */
class ControlTransport {
  constructor(
    readonly request: APIRequestContext,
    readonly baseUrl: string,
  ) {}

  url(path: string): string {
    return `${this.baseUrl}${path.charAt(0) === '/' ? path : `/${path}`}`;
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(this.url(path));
    return this.unwrap<T>(response.status(), await response.text(), 'GET', path);
  }

  /** Like `get`, but a 404 resolves to `null` instead of throwing. */
  async getOrNull<T>(path: string): Promise<T | null> {
    const response = await this.request.get(this.url(path));
    if (response.status() === 404) return null;
    return this.unwrap<T>(response.status(), await response.text(), 'GET', path);
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    const response = await this.request.post(this.url(path), {
      headers: { 'content-type': 'application/json' },
      data: data === undefined ? {} : (data as object),
    });
    return this.unwrap<T>(response.status(), await response.text(), 'POST', path);
  }

  private unwrap<T>(status: number, text: string, method: string, path: string): T {
    if (status < 200 || status >= 300) {
      const error: ControlError = new Error(
        `Control API ${method} ${path} failed with ${status}: ${text.slice(0, 500)}`,
      );
      error.status = status;
      error.bodyText = text;
      throw error;
    }
    if (text.length === 0) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }
}

// ---------------------------------------------------------------------------
// Firms
// ---------------------------------------------------------------------------

export class MockFirms {
  constructor(private readonly http: ControlTransport) {}

  /** `GET /__control/firms/by-token/:token`. Throws if the token is unknown. */
  async byToken(token: string): Promise<FirmView> {
    return this.http.get<FirmView>(`/__control/firms/by-token/${encodeURIComponent(token)}`);
  }

  /** Same, but an unknown token resolves to `null`. */
  async tryByToken(token: string): Promise<FirmView | null> {
    return this.http.getOrNull<FirmView>(
      `/__control/firms/by-token/${encodeURIComponent(token)}`,
    );
  }

  /** Every firm in the mock store. */
  async list(): Promise<FirmView[]> {
    const response = await this.http.get<{ firms: FirmView[] }>('/__control/firms');
    return response.firms;
  }

  /** One firm by id. Throws if it is not in the store. */
  async get(firmId: string): Promise<FirmView> {
    const firm = await this.find(firmId);
    if (!firm) throw new Error(`No firm ${firmId} in the mock store`);
    return firm;
  }

  /** One firm by id, or `null`. */
  async find(firmId: string): Promise<FirmView | null> {
    const firms = await this.list();
    const matches = firms.filter((firm) => firm.id === firmId);
    return matches.length > 0 ? matches[0] : null;
  }

  /** Polls until the firm reaches `status` (e.g. after the onboarding shim submits). */
  async waitForStatus(
    firmId: string,
    status: FirmStatus,
    options: { timeout?: number } = {},
  ): Promise<FirmView> {
    await expect
      .poll(async () => (await this.get(firmId)).status, {
        timeout: options.timeout ?? DEFAULT_WAIT_TIMEOUT,
        message: `Waiting for firm ${firmId} to reach ${status}`,
      })
      .toBe(status);
    return this.get(firmId);
  }

  /** Parks a firm in an arbitrary `FirmStatus` (e.g. `APP_IN_REVIEW`). */
  async setStatus(firmId: string, status: FirmStatus): Promise<FirmView> {
    return this.http.post<FirmView>(
      `/__control/firms/${encodeURIComponent(firmId)}/status`,
      { status },
    );
  }

  /** `status: 'ACTIVE'`, `isAcceptingPayments: true` — mirrors `sandboxOnlyActivateFirm`. */
  async activate(firmId: string): Promise<FirmView> {
    return this.http.post<FirmView>(`/__control/firms/${encodeURIComponent(firmId)}/activate`);
  }

  async deactivate(firmId: string): Promise<FirmView> {
    return this.http.post<FirmView>(`/__control/firms/${encodeURIComponent(firmId)}/deactivate`);
  }

  /**
   * Turns the 3% surcharging notice on the Payment Intents page on or off.
   * `rate` defaults to the mock's 0.03.
   */
  async surcharging(firmId: string, enabled: boolean, rate?: number): Promise<FirmView> {
    return this.http.post<FirmView>(
      `/__control/firms/${encodeURIComponent(firmId)}/surcharging`,
      rate === undefined ? { enabled } : { enabled, rate },
    );
  }

  /**
   * Revokes every token the firm holds, out of band — the recovery path
   * `GET /api/session` takes when Confido invalidates a token behind the app's
   * back (PLAN.md §0.1).
   */
  async revokeTokens(firmId: string): Promise<FirmView> {
    return this.http.post<FirmView>(
      `/__control/firms/${encodeURIComponent(firmId)}/revoke-tokens`,
    );
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export class MockConnect {
  constructor(private readonly http: ControlTransport) {}

  /**
   * Creates an ACTIVE firm plus a one-time connect code, exactly as the fake
   * Confido authorize page would. Feed `code` to
   * `GET /api/gravity-callback?code=…&state=…`.
   */
  async mint(name?: string): Promise<MintedConnect> {
    return this.http.post<MintedConnect>(
      '/__control/connect/mint',
      name === undefined ? {} : { name },
    );
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventFilter {
  /** Exact `operationName` match, e.g. `'paymentSessionComplete'`. */
  op?: string;
  /** Only operations authenticated as this firm. */
  firmId?: string;
}

export interface WaitForEventOptions extends EventFilter {
  /** Exclusive lower bound on `seq` — pass the value from `events.mark()`. */
  since?: number;
  /** Extra predicate, applied client-side. */
  where?: (event: MockEvent) => boolean;
  /** Resolve once this many matching events exist. Default 1. */
  count?: number;
  /** Poll budget in ms. Default 15000. */
  timeout?: number;
}

export class MockEvents {
  constructor(private readonly http: ControlTransport) {}

  /** `GET /__control/events?since=&op=&firmId=` — the raw response. */
  async since(seq: number, filter: EventFilter = {}): Promise<EventsResponse> {
    const params: string[] = [`since=${encodeURIComponent(String(seq))}`];
    if (filter.op) params.push(`op=${encodeURIComponent(filter.op)}`);
    if (filter.firmId) params.push(`firmId=${encodeURIComponent(filter.firmId)}`);
    return this.http.get<EventsResponse>(`/__control/events?${params.join('&')}`);
  }

  /** Every recorded event matching the filter, from the start of the run. */
  async all(filter: EventFilter = {}): Promise<MockEvent[]> {
    const response = await this.since(0, filter);
    return response.events;
  }

  /** Events after `since` matching the filter. */
  async list(options: WaitForEventOptions = {}): Promise<MockEvent[]> {
    const response = await this.since(options.since ?? 0, options);
    return filterEvents(response.events, options.where);
  }

  async count(options: WaitForEventOptions = {}): Promise<number> {
    return (await this.list(options)).length;
  }

  /**
   * The current highest sequence number, without transferring the buffer.
   * Take a mark before the action, then pass it as `since` so a previous test's
   * events (the mock store is shared across workers) can never match.
   */
  async mark(): Promise<number> {
    const response = await this.since(Number.MAX_SAFE_INTEGER);
    return response.seq;
  }

  /**
   * Polls `/__control/events` until at least `count` matching events exist, and
   * returns the last one. This is the sanctioned replacement for
   * `page.waitForTimeout` when waiting on a server-side Confido call.
   */
  async waitFor(options: WaitForEventOptions = {}): Promise<MockEvent> {
    const matches = await this.waitForAll(options);
    return matches[matches.length - 1];
  }

  /** Same as `waitFor`, but returns every matching event. */
  async waitForAll(options: WaitForEventOptions = {}): Promise<MockEvent[]> {
    const wanted = options.count ?? 1;
    const hits: MockEvent[] = [];
    await expect
      .poll(
        async () => {
          const response = await this.since(options.since ?? 0, options);
          const matched = filterEvents(response.events, options.where);
          hits.length = 0;
          matched.forEach((event) => hits.push(event));
          return hits.length;
        },
        {
          timeout: options.timeout ?? DEFAULT_WAIT_TIMEOUT,
          message: `Waiting for ${wanted} mock GraphQL event(s) matching ${describeFilter(options)}`,
        },
      )
      .toBeGreaterThanOrEqual(wanted);
    return hits;
  }
}

function filterEvents(
  events: MockEvent[],
  where?: (event: MockEvent) => boolean,
): MockEvent[] {
  if (!where) return events;
  return events.filter(where);
}

function describeFilter(filter: WaitForEventOptions): string {
  const parts: string[] = [];
  parts.push(`op=${filter.op ?? '*'}`);
  if (filter.firmId) parts.push(`firmId=${filter.firmId}`);
  if (filter.since !== undefined) parts.push(`since=${filter.since}`);
  if (filter.where) parts.push('where=<predicate>');
  return `{ ${parts.join(', ')} }`;
}

// ---------------------------------------------------------------------------
// Sessions (hosted-fields / save-payment-method)
// ---------------------------------------------------------------------------

export class MockSessions {
  constructor(private readonly http: ControlTransport) {}

  /** `GET /__control/sessions/:token`. Throws if the token is unknown. */
  async get(token: string): Promise<SessionView> {
    return this.http.get<SessionView>(`/__control/sessions/${encodeURIComponent(token)}`);
  }

  /** Same, but an unknown token resolves to `null` (what the shim treats as `Invalid payment token`). */
  async tryGet(token: string): Promise<SessionView | null> {
    return this.http.getOrNull<SessionView>(
      `/__control/sessions/${encodeURIComponent(token)}`,
    );
  }

  /**
   * Stages an instrument on a session without going through the browser — the
   * same call the hosted-fields shim makes from `submitFields()`.
   */
  async stage(token: string, instrument: StagedInstrument): Promise<SessionView> {
    return this.http.post<SessionView>(
      `/__control/sessions/${encodeURIComponent(token)}/stage`,
      instrument,
    );
  }

  /** Polls until a session exists for `token` (it is created server-side). */
  async waitFor(token: string, timeout = DEFAULT_WAIT_TIMEOUT): Promise<SessionView> {
    await expect
      .poll(async () => (await this.tryGet(token)) !== null, {
        timeout,
        message: `Waiting for mock session ${token}`,
      })
      .toBe(true);
    return this.get(token);
  }
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export class MockOnboarding {
  constructor(private readonly http: ControlTransport) {}

  /** Moves the firm behind an onboarding token to `APP_SUBMITTED`. */
  async submit(token: string): Promise<FirmView> {
    return this.http.post<FirmView>(
      `/__control/onboarding/${encodeURIComponent(token)}/submit`,
    );
  }
}

// ---------------------------------------------------------------------------
// Paylinks
// ---------------------------------------------------------------------------

export class MockPaylinks {
  constructor(private readonly http: ControlTransport) {}

  /**
   * Seeds a payment link for ONE firm, so `createPaymentToken({ paymentLinkId })`
   * resolves for that firm and keeps failing with `Paylink not found` for every
   * other one. Links are firm-scoped precisely so parallel tests cannot collide
   * over the single hardcoded id.
   */
  async seed(firmId: string, id: string, totalAmount: number): Promise<PaymentLinkRecord> {
    return this.http.post<PaymentLinkRecord>('/__control/paylinks/seed', {
      firmId,
      id,
      totalAmount,
    });
  }

  /**
   * Seeds the id `src/pages/paylinks.tsx:24` hardcodes, for the given firm.
   * Default total: $250.00. Pass `connectedUser.firmId`.
   */
  async seedPaylinksPage(firmId: string, totalAmount = 25_000): Promise<PaymentLinkRecord> {
    return this.seed(firmId, PAYLINKS_PAGE_PAYMENT_LINK_ID, totalAmount);
  }
}

// ---------------------------------------------------------------------------
// The client itself
// ---------------------------------------------------------------------------

export class MockControl {
  readonly baseUrl: string;
  readonly firms: MockFirms;
  readonly connect: MockConnect;
  readonly events: MockEvents;
  readonly sessions: MockSessions;
  readonly onboarding: MockOnboarding;
  readonly paylinks: MockPaylinks;

  private readonly http: ControlTransport;

  constructor(request: APIRequestContext, baseUrl: string = MOCK) {
    this.baseUrl = baseUrl;
    this.http = new ControlTransport(request, baseUrl);
    this.firms = new MockFirms(this.http);
    this.connect = new MockConnect(this.http);
    this.events = new MockEvents(this.http);
    this.sessions = new MockSessions(this.http);
    this.onboarding = new MockOnboarding(this.http);
    this.paylinks = new MockPaylinks(this.http);
  }

  /** Absolute URL for a mock path, e.g. `mock.url('/iframe-target')`. */
  url(path: string): string {
    return this.http.url(path);
  }

  /** `GET /healthz`. */
  async health(): Promise<{ ok: boolean; service: string }> {
    return this.http.get<{ ok: boolean; service: string }>('/healthz');
  }

  /** `GET /__control/state` — the whole store, for assertions and debugging. */
  async state(): Promise<StateDump> {
    return this.http.get<StateDump>('/__control/state');
  }

  /**
   * `POST /__control/reset`.
   *
   * DANGER: the mock store is shared by every worker. Only call this from a
   * `test.describe.configure({ mode: 'serial' })` block that owns the whole run,
   * or from a single-worker spec. Normal isolation comes from each test minting
   * its own user and firm, never from resetting.
   */
  async reset(): Promise<void> {
    await this.http.post<void>('/__control/reset');
  }
}
