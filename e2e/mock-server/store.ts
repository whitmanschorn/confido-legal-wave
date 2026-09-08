/**
 * In-memory state for the mock Confido API.
 *
 * Every mutation of mock state goes through a function in this file so the
 * GraphQL resolvers, the control API and the fake Confido app pages can never
 * drift apart. See PLAN.md §3.2.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import type {
  AuthContext,
  ClientRecord,
  ConnectCodeRecord,
  FirmRecord,
  FirmStatus,
  FirmView,
  OnboardingTokenRecord,
  PartnerRecord,
  PaymentLinkRecord,
  PaymentRecord,
  SessionRecord,
  SessionView,
  SignUpLinkRecord,
  SpmRecord,
  StagedInstrument,
  StateDump,
  TokenRecord,
} from './types';
import { PARTNER_TOKEN, TOKEN_PREFIX } from './types';

// ---------------------------------------------------------------------------
// Well-known constants. 127.0.0.1 everywhere, never localhost.
// ---------------------------------------------------------------------------

export const MOCK_PORT = Number(process.env.MOCK_PORT ?? 7002);
export const MOCK_ORIGIN = process.env.MOCK_ORIGIN ?? `http://127.0.0.1:${MOCK_PORT}`;
export const APP_PORT = Number(process.env.APP_PORT ?? 7001);
export const APP_ORIGIN = process.env.APP_ORIGIN ?? `http://127.0.0.1:${APP_PORT}`;

/** Where the fake Connect page sends the browser after "Authorize". */
export const CALLBACK_URL = `${APP_ORIGIN}/api/gravity-callback`;

/** Default surcharge rate applied when a firm has surcharging switched on. */
export const DEFAULT_SURCHARGE_RATE = 0.03;

/** totalAmount used for payment links the mock invents (cents). */
export const DEFAULT_PAYLINK_TOTAL_AMOUNT = 25000;

export { PARTNER_TOKEN };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const partner: PartnerRecord = {
  id: 'partner_mock',
  appId: 'mock-app',
  title: 'Legal Wave (mock)',
};

const firms = new Map<string, FirmRecord>();
const tokens = new Map<string, TokenRecord>();
const connectCodes = new Map<string, ConnectCodeRecord>();
const signUpLinks = new Map<string, SignUpLinkRecord>();
const onboardingTokens = new Map<string, OnboardingTokenRecord>();
const clients = new Map<string, ClientRecord>();
const sessions = new Map<string, SessionRecord>();
const payments = new Map<string, PaymentRecord>();
const spms = new Map<string, SpmRecord>();
const paylinks = new Map<string, PaymentLinkRecord>();

/**
 * Deliberately NOT cleared by reset(): keeping session tokens globally unique
 * for the life of the process means a reset mid-run can never hand a stale
 * browser a token that now belongs to someone else.
 */
let sessionCounter = 0;
let firmCounter = 0;

const nowIso = () => new Date().toISOString();
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const plusMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

export function reset(): void {
  firms.clear();
  tokens.clear();
  connectCodes.clear();
  signUpLinks.clear();
  onboardingTokens.clear();
  clients.clear();
  sessions.clear();
  payments.clear();
  spms.clear();
  paylinks.clear();
}

export function getPartner(): PartnerRecord {
  return partner;
}

// ---------------------------------------------------------------------------
// Firms and tokens
// ---------------------------------------------------------------------------

export interface CreateFirmOptions {
  name?: string;
  /** true → ACTIVE + isAcceptingPayments (what Connect and mockOnboarding do). */
  active?: boolean;
}

export function createFirm(options: CreateFirmOptions = {}): FirmRecord {
  firmCounter += 1;
  const active = options.active ?? false;
  const firm: FirmRecord = {
    id: randomUUID(),
    name: options.name?.trim() || `Mock Firm ${firmCounter}`,
    status: active ? 'ACTIVE' : 'CREATED',
    isAcceptingPayments: active,
    surchargingEnabled: false,
    surchargeRate: DEFAULT_SURCHARGE_RATE,
    tokens: new Set(),
    revokedTokens: new Set(),
    createdAt: nowIso(),
  };
  firms.set(firm.id, firm);
  return firm;
}

export function getFirm(firmId: string): FirmRecord | undefined {
  return firms.get(firmId);
}

export function listFirms(): FirmRecord[] {
  return Array.from(firms.values());
}

/**
 * Mint the firm API token. A firm gets exactly one token: `f_secret_mock_<firmId>`.
 * Calling this twice for the same firm returns the same (un-revoked) token,
 * which mirrors the app's single-token-per-firm usage.
 */
export function issueFirmToken(firmId: string): string {
  const firm = firms.get(firmId);
  if (!firm) throw new Error(`issueFirmToken: unknown firm ${firmId}`);

  const token = `${TOKEN_PREFIX.firm}${firmId}`;
  const existing = tokens.get(token);
  if (existing && !existing.revoked) return token;

  tokens.set(token, { token, firmId, revoked: false, createdAt: nowIso() });
  firm.tokens.add(token);
  firm.revokedTokens.delete(token);
  return token;
}

export function revokeToken(token: string): boolean {
  const record = tokens.get(token);
  if (!record || record.revoked) return false;
  record.revoked = true;
  firms.get(record.firmId)?.revokedTokens.add(token);
  return true;
}

export function revokeFirmTokens(firmId: string): number {
  let n = 0;
  tokens.forEach((record) => {
    if (record.firmId === firmId && !record.revoked) {
      record.revoked = true;
      firms.get(firmId)?.revokedTokens.add(record.token);
      n += 1;
    }
  });
  return n;
}

export function findFirmByToken(token: string): FirmRecord | undefined {
  const record = tokens.get(token);
  return record ? firms.get(record.firmId) : undefined;
}

/**
 * Classify an incoming `x-api-key`. See PLAN.md §0.1 for the response each
 * kind must produce.
 */
export function resolveToken(token: string | null | undefined): AuthContext {
  if (!token) return { kind: 'none', token: null, firmId: null };
  if (token === PARTNER_TOKEN) return { kind: 'partner', token, firmId: null };

  const record = tokens.get(token);
  if (!record) return { kind: 'unknown', token, firmId: null };
  if (record.revoked) return { kind: 'revoked', token, firmId: record.firmId };
  return { kind: 'firm', token, firmId: record.firmId };
}

export function activateFirm(firmId: string): FirmRecord | undefined {
  const firm = firms.get(firmId);
  if (!firm) return undefined;
  firm.status = 'ACTIVE';
  firm.isAcceptingPayments = true;
  return firm;
}

export function deactivateFirm(firmId: string): FirmRecord | undefined {
  const firm = firms.get(firmId);
  if (!firm) return undefined;
  firm.status = 'CREATED';
  firm.isAcceptingPayments = false;
  return firm;
}

export function setFirmStatus(firmId: string, status: FirmStatus): FirmRecord | undefined {
  const firm = firms.get(firmId);
  if (!firm) return undefined;
  firm.status = status;
  return firm;
}

export function setSurcharging(
  firmId: string,
  enabled: boolean,
  rate = DEFAULT_SURCHARGE_RATE,
): FirmRecord | undefined {
  const firm = firms.get(firmId);
  if (!firm) return undefined;
  firm.surchargingEnabled = enabled;
  firm.surchargeRate = rate;
  return firm;
}

// ---------------------------------------------------------------------------
// Connect codes
// ---------------------------------------------------------------------------

export function createConnectCode(firmId: string): ConnectCodeRecord {
  const record: ConnectCodeRecord = {
    code: `code_${hex(16)}`,
    firmId,
    used: false,
    createdAt: nowIso(),
  };
  connectCodes.set(record.code, record);
  return record;
}

export function getConnectCode(code: string): ConnectCodeRecord | undefined {
  return connectCodes.get(code);
}

/** One-time: returns the firm id on first use, undefined on every later use. */
export function consumeConnectCode(code: string): string | undefined {
  const record = connectCodes.get(code);
  if (!record || record.used) return undefined;
  record.used = true;
  return record.firmId;
}

// ---------------------------------------------------------------------------
// Sign-up links and onboarding tokens
// ---------------------------------------------------------------------------

export function createSignUpLink(firmId: string): SignUpLinkRecord {
  const code = hex(16); // 32 hex chars, as the real API returns
  const record: SignUpLinkRecord = {
    code,
    firmId,
    link: `${MOCK_ORIGIN}/app/signup?s_code=${code}`,
    expiresAt: plusMinutes(20),
  };
  signUpLinks.set(code, record);
  return record;
}

export function getSignUpLink(code: string): SignUpLinkRecord | undefined {
  return signUpLinks.get(code);
}

export function createOnboardingToken(firmId: string): OnboardingTokenRecord {
  const record: OnboardingTokenRecord = {
    token: `${TOKEN_PREFIX.onboarding}${hex(16)}`,
    firmId,
    expiresAt: plusMinutes(24 * 60),
    submitted: false,
  };
  onboardingTokens.set(record.token, record);
  return record;
}

export function getOnboardingToken(token: string): OnboardingTokenRecord | undefined {
  return onboardingTokens.get(token);
}

/** The fake onboarding form's submit: firm moves to APP_SUBMITTED. */
export function submitOnboarding(token: string): OnboardingTokenRecord | undefined {
  const record = onboardingTokens.get(token);
  if (!record) return undefined;
  record.submitted = true;
  setFirmStatus(record.firmId, 'APP_SUBMITTED');
  return record;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export function addClient(firmId: string, clientName: string): ClientRecord {
  const record: ClientRecord = {
    id: randomUUID(),
    firmId,
    clientName,
    email: null,
    phone: null,
    createdAt: nowIso(),
  };
  clients.set(record.id, record);
  return record;
}

export function getClient(clientId: string): ClientRecord | undefined {
  return clients.get(clientId);
}

export function listClients(): ClientRecord[] {
  return Array.from(clients.values());
}

// ---------------------------------------------------------------------------
// Payment links (seeded by tests via POST /__control/paylinks/seed)
// ---------------------------------------------------------------------------

export function seedPaylink(id: string, totalAmount: number): PaymentLinkRecord {
  const record: PaymentLinkRecord = { id, totalAmount };
  paylinks.set(id, record);
  return record;
}

export function getPaylink(id: string): PaymentLinkRecord | undefined {
  return paylinks.get(id);
}

export function listPaylinks(): PaymentLinkRecord[] {
  return Array.from(paylinks.values());
}

// ---------------------------------------------------------------------------
// Hosted-fields sessions
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  kind: 'payment' | 'spm';
  firmId: string;
  paymentLink?: PaymentLinkRecord;
  clientId?: string;
}

export function createSession(options: CreateSessionOptions): SessionRecord {
  sessionCounter += 1;
  const prefix =
    options.kind === 'payment' ? TOKEN_PREFIX.payment : TOKEN_PREFIX.savePaymentMethod;
  const record: SessionRecord = {
    token: `${prefix}${sessionCounter}_${hex(8)}`,
    kind: options.kind,
    firmId: options.firmId,
    paymentLink: options.paymentLink,
    clientId: options.clientId,
    used: false,
    createdAt: nowIso(),
    expiresAt: plusMinutes(60),
  };
  sessions.set(record.token, record);
  return record;
}

export function getSession(token: string): SessionRecord | undefined {
  return sessions.get(token);
}

export function stageInstrument(
  token: string,
  instrument: StagedInstrument,
): SessionRecord | undefined {
  const record = sessions.get(token);
  if (!record) return undefined;
  record.staged = instrument;
  return record;
}

export function markSessionUsed(token: string): void {
  const record = sessions.get(token);
  if (record) record.used = true;
}

export function listSessions(): SessionRecord[] {
  return Array.from(sessions.values());
}

export function sessionView(record: SessionRecord): SessionView {
  const firm = firms.get(record.firmId);
  return {
    token: record.token,
    kind: record.kind,
    firmId: record.firmId,
    paymentLink: record.paymentLink ?? null,
    surchargingEnabled: firm?.surchargingEnabled ?? false,
    surchargeRate: firm?.surchargeRate ?? DEFAULT_SURCHARGE_RATE,
    used: record.used,
  };
}

// ---------------------------------------------------------------------------
// Payments and stored payment methods
// ---------------------------------------------------------------------------

export function recordPayment(payment: PaymentRecord): PaymentRecord {
  payments.set(payment.id, payment);
  return payment;
}

export function newPaymentId(): string {
  return randomUUID();
}

export function newTransactionId(): string {
  return randomUUID();
}

export function findPaymentsByExternalId(
  firmId: string,
  externalId: string,
): PaymentRecord[] {
  return Array.from(payments.values()).filter(
    (p) => p.firmId === firmId && p.externalId === externalId,
  );
}

export function listPayments(): PaymentRecord[] {
  return Array.from(payments.values());
}

export function createSpm(input: Omit<SpmRecord, 'id' | 'createdAt' | 'status'>): SpmRecord {
  const record: SpmRecord = {
    ...input,
    id: randomUUID(),
    status: 'active',
    createdAt: nowIso(),
  };
  spms.set(record.id, record);
  return record;
}

export function getSpm(id: string): SpmRecord | undefined {
  return spms.get(id);
}

export function listSpms(): SpmRecord[] {
  return Array.from(spms.values());
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function firmView(firm: FirmRecord): FirmView {
  return {
    id: firm.id,
    name: firm.name,
    status: firm.status,
    isAcceptingPayments: firm.isAcceptingPayments,
    surchargingEnabled: firm.surchargingEnabled,
    surchargeRate: firm.surchargeRate,
    tokens: Array.from(firm.tokens),
    revokedTokens: Array.from(firm.revokedTokens),
    createdAt: firm.createdAt,
  };
}

export function stateDump(eventCount: number): StateDump {
  return {
    partner,
    firms: listFirms().map(firmView),
    clients: listClients(),
    sessions: listSessions(),
    payments: listPayments(),
    spms: listSpms(),
    paylinks: listPaylinks(),
    connectCodes: Array.from(connectCodes.values()),
    signUpLinks: Array.from(signUpLinks.values()),
    onboardingTokens: Array.from(onboardingTokens.values()),
    eventCount,
  };
}
