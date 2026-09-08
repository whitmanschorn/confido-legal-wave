/**
 * Shared type contracts for the mock Confido API.
 *
 * Everything in here is a frozen contract between the mock server (store /
 * resolvers / control API), the browser SDK shims, the Playwright fixtures and
 * the specs. Nothing here may change without updating e2e/PLAN.md first.
 */

// ---------------------------------------------------------------------------
// Enum-ish unions, mirroring e2e/mock-server/schema.graphql exactly.
// ---------------------------------------------------------------------------

/** schema.graphql: enum FirmStatus */
export type FirmStatus =
  | 'CREATED'
  | 'APP_IN_DRAFT'
  | 'APP_SUBMITTED'
  | 'APP_IN_REVIEW'
  | 'ACTIVE'
  | 'DECLINED'
  | 'HELD'
  | 'INACTIVE'
  | 'SUSPENDED';

/** schema.graphql: enum PaymentStatus — lowercase, deliberately. */
export type PaymentStatus = 'error' | 'success' | 'partial_success' | 'failed';

/** schema.graphql: enum TransactionStatus2 */
export type TransactionStatus2 =
  | 'CHARGED_BACK'
  | 'DEPOSITED'
  | 'ERROR'
  | 'FUNDS_IN_TRANSIT'
  | 'HELD'
  | 'PARTIALLY_REFUNDED'
  | 'PENDING'
  | 'REFUNDED'
  | 'RETURNED'
  | 'SUCCESSFUL'
  | 'VOIDED';

/** schema.graphql: enum PaymentSessionMethod (what the app sends). */
export type PaymentSessionMethod = 'ACH' | 'CREDIT' | 'DEBIT';

/** schema.graphql: enum TransactionPaymentMethod (what Transaction exposes). */
export type TransactionPaymentMethod =
  | 'ACH'
  | 'CARD'
  | 'CREDIT'
  | 'DEBIT'
  | 'MANUAL'
  | 'PAYPAL'
  | 'PUSH_TO_CARD'
  | 'ZELLE';

/** The two hosted-fields forms. Matches src/confido-legal-hook/ConfidoLegal.d.ts. */
export type FormType = 'card' | 'ach';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type TokenKind = 'partner' | 'firm' | 'none' | 'unknown' | 'revoked';

export const PARTNER_TOKEN = 'p_secret_mock_partner';

export const TOKEN_PREFIX = {
  partner: 'p_secret_mock_',
  firm: 'f_secret_mock_',
  payment: 'pay_public_mock_',
  savePaymentMethod: 'spm_public_mock_',
  onboarding: 'onboarding_public_mock_',
} as const;

export interface AuthContext {
  kind: TokenKind;
  token: string | null;
  firmId: string | null;
}

// ---------------------------------------------------------------------------
// Store records (§3.2 of PLAN.md)
// ---------------------------------------------------------------------------

export interface PartnerRecord {
  id: string;
  appId: string;
  title: string;
}

export interface FirmRecord {
  id: string;
  name: string;
  status: FirmStatus;
  isAcceptingPayments: boolean;
  surchargingEnabled: boolean;
  surchargeRate: number;
  /** Every firm API token ever minted for this firm. */
  tokens: Set<string>;
  /** Tokens that were revoked (by disconnectFromPartner or the control API). */
  revokedTokens: Set<string>;
  createdAt: string;
}

export interface TokenRecord {
  token: string;
  firmId: string;
  revoked: boolean;
  createdAt: string;
}

/** One-time code handed to /api/gravity-callback by the fake Connect page. */
export interface ConnectCodeRecord {
  code: string;
  firmId: string;
  used: boolean;
  createdAt: string;
}

export interface SignUpLinkRecord {
  code: string;
  firmId: string;
  link: string;
  expiresAt: string;
}

export interface OnboardingTokenRecord {
  token: string;
  firmId: string;
  expiresAt: string;
  submitted: boolean;
}

export interface ClientRecord {
  id: string;
  firmId: string;
  clientName: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

/** A payment link that a test seeded via POST /__control/paylinks/seed. */
export interface PaymentLinkRecord {
  id: string;
  totalAmount: number;
}

/** What the hosted-fields shim POSTs to /__control/sessions/:token/stage. */
export interface StagedInstrument {
  form: FormType;
  paymentMethod: PaymentSessionMethod;
  /** card form */
  cardNumber?: string;
  cardExpirationDate?: string;
  cardSecurityCode?: string;
  cardBrand?: string;
  /** ach form */
  accountNumber?: string;
  routingNumber?: string;
  accountHolderName?: string;
  /** last four of whichever instrument was staged */
  lastFour?: string;
}

export interface SessionRecord {
  token: string;
  kind: 'payment' | 'spm';
  firmId: string;
  paymentLink?: PaymentLinkRecord;
  clientId?: string;
  staged?: StagedInstrument;
  used: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface TransactionRecord {
  id: string;
  amountProcessed: number;
  status_v2: TransactionStatus2;
  paymentMethod: TransactionPaymentMethod;
  externalId: string | null;
  lastFour: string | null;
  cardBrand: string | null;
  payerName: string | null;
  payerEmail: string | null;
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  firmId: string;
  externalId: string | null;
  status: PaymentStatus;
  amount: number;
  method: PaymentSessionMethod;
  cardBrand: string | null;
  transactions: TransactionRecord[];
  storedPaymentMethodId: string | null;
  payerName: string | null;
  payerEmail: string | null;
  sendReceipt: boolean | null;
  savePaymentMethod: boolean;
  createdAt: string;
}

export interface SpmRecord {
  id: string;
  firmId: string;
  lastFour: string;
  cardBrand: string | null;
  /** StoredPaymentMethod.paymentMethod is a plain String! in the SDL. */
  paymentMethod: string;
  payerName: string | null;
  payerEmail: string | null;
  clientId: string | null;
  status: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Event log (§3.1) — every GraphQL operation the mock receives.
// ---------------------------------------------------------------------------

export interface MockEvent {
  /** Date.now() when the operation finished. */
  ts: number;
  /** Monotonic sequence number, so `since` paging is exact. */
  seq: number;
  operationName: string | null;
  tokenKind: TokenKind;
  firmId: string | null;
  variables: Record<string, unknown>;
  ok: boolean;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Control API payloads (§3.4) — consumed by fixtures/mock-client.ts.
// ---------------------------------------------------------------------------

/** GET /__control/firms/by-token/:token, and the firm shape inside /__control/state. */
export interface FirmView {
  id: string;
  name: string;
  status: FirmStatus;
  isAcceptingPayments: boolean;
  surchargingEnabled: boolean;
  surchargeRate: number;
  tokens: string[];
  revokedTokens: string[];
  createdAt: string;
}

/** POST /__control/connect/mint */
export interface MintedConnect {
  firmId: string;
  firmName: string;
  code: string;
  /** The token the firm will receive once the code is exchanged. */
  firmToken: string;
}

/** GET /__control/sessions/:token — what the hosted-fields shim boots from. */
export interface SessionView {
  token: string;
  kind: 'payment' | 'spm';
  firmId: string;
  paymentLink: PaymentLinkRecord | null;
  surchargingEnabled: boolean;
  surchargeRate: number;
  used: boolean;
}

/** GET /__control/state */
export interface StateDump {
  partner: PartnerRecord;
  firms: FirmView[];
  clients: ClientRecord[];
  sessions: SessionRecord[];
  payments: PaymentRecord[];
  spms: SpmRecord[];
  paylinks: PaymentLinkRecord[];
  connectCodes: ConnectCodeRecord[];
  signUpLinks: SignUpLinkRecord[];
  onboardingTokens: OnboardingTokenRecord[];
  eventCount: number;
}

/** GET /__control/events?since=&op= */
export interface EventsResponse {
  events: MockEvent[];
  /** Highest seq in the store; pass back as `since` to page. */
  seq: number;
}
