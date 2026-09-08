/**
 * Hand-written resolvers for exactly the 14 operations Legal Wave issues
 * (PLAN.md §3.3). Error messages and `extensions.code` values reproduce the
 * live sandbox verbatim (PLAN.md §0.1).
 *
 * All state lives in `./store`. Nothing is cached here.
 */

import { GraphQLError } from 'graphql';
import * as store from './store';
import type {
  ClientRecord,
  FirmRecord,
  PaymentLinkRecord,
  PaymentRecord,
  PaymentSessionMethod,
  SessionRecord,
  SpmRecord,
  StagedInstrument,
  TransactionPaymentMethod,
  TransactionRecord,
  AuthContext,
} from './types';

// ---------------------------------------------------------------------------
// Context + errors
// ---------------------------------------------------------------------------

export interface MockContext {
  auth: AuthContext;
}

/** Verbatim from the live API when no `x-api-key` is sent (PLAN.md §0.1). */
export const ACCESS_DENIED_MESSAGE =
  "Access denied! You don't have permission for this action!";

/** Verbatim from the live API for an unknown/malformed token (PLAN.md §0.1). */
export const INVALID_TOKEN_MESSAGE = 'Context creation failed: Invalid firm token.';

/** Verbatim from the live API for a revoked token (PLAN.md §0.1). */
export const REVOKED_TOKEN_MESSAGE = 'Context creation failed: Token has been revoked.';

/** Not-found / validation errors. */
function userInputError(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'USER_INPUT_ERROR' } });
}

/** Business-rule errors. */
function businessError(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
}

function accessDenied(): GraphQLError {
  return new GraphQLError(ACCESS_DENIED_MESSAGE, {
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  });
}

function requirePartner(ctx: MockContext): void {
  if (ctx.auth.kind !== 'partner') throw accessDenied();
}

function requireFirm(ctx: MockContext): FirmRecord {
  if (ctx.auth.kind !== 'firm' || !ctx.auth.firmId) throw accessDenied();
  const firm = store.getFirm(ctx.auth.firmId);
  if (!firm) throw accessDenied();
  return firm;
}

// ---------------------------------------------------------------------------
// Shapes. Only the fields the app selects are returned; addMocksToSchema fills
// in everything else, so these objects stay deliberately small.
// ---------------------------------------------------------------------------

function firmShape(firm: FirmRecord): Record<string, unknown> {
  return {
    id: firm.id,
    name: firm.name,
    isAcceptingPayments: firm.isAcceptingPayments,
    status: firm.status,
    status2: firm.status,
  };
}

function clientShape(client: ClientRecord): Record<string, unknown> {
  return {
    id: client.id,
    clientName: client.clientName,
    email: client.email,
    phone: client.phone,
    createdOn: client.createdAt,
  };
}

function transactionShape(txn: TransactionRecord): Record<string, unknown> {
  return {
    id: txn.id,
    amountProcessed: txn.amountProcessed,
    status_v2: txn.status_v2,
    paymentMethod: txn.paymentMethod,
    cardBrand: txn.cardBrand,
    lastFour: txn.lastFour,
    payerName: txn.payerName,
    payerEmail: txn.payerEmail,
    createdOn: txn.createdAt,
    payRequest: { externalId: txn.externalId },
  };
}

function spmShape(spm: SpmRecord): Record<string, unknown> {
  return {
    id: spm.id,
    lastFour: spm.lastFour,
    cardBrand: spm.cardBrand,
    paymentMethod: spm.paymentMethod,
    payerName: spm.payerName,
    status: spm.status,
  };
}

// ---------------------------------------------------------------------------
// Instrument helpers
// ---------------------------------------------------------------------------

function digits(value: string | undefined | null): string {
  return (value ?? '').replace(/[^0-9]/g, '');
}

function lastFourOf(staged: StagedInstrument): string {
  if (staged.lastFour) return staged.lastFour;
  const source = staged.form === 'card' ? digits(staged.cardNumber) : digits(staged.accountNumber);
  return source.slice(-4);
}

function brandOf(staged: StagedInstrument): string | null {
  if (staged.form !== 'card') return null;
  if (staged.cardBrand) return staged.cardBrand;
  const number = digits(staged.cardNumber);
  if (number.charAt(0) === '4') return 'visa';
  if (number.charAt(0) === '5' || number.charAt(0) === '2') return 'mastercard';
  if (number.charAt(0) === '3') return 'amex';
  if (number.charAt(0) === '6') return 'discover';
  return null;
}

function txnMethodOf(
  staged: StagedInstrument,
  method: PaymentSessionMethod,
): TransactionPaymentMethod {
  // Confido's documented "debit card" test number always settles as DEBIT.
  if (staged.form === 'card' && digits(staged.cardNumber) === '4000056655665556') {
    return 'DEBIT';
  }
  if (method === 'ACH') return 'ACH';
  if (method === 'DEBIT') return 'DEBIT';
  return 'CREDIT';
}

/**
 * PLAN.md §3.3 decision table. Throws for the declined / invalid cases.
 */
function assertInstrumentAccepted(staged: StagedInstrument, amount: number): void {
  if (staged.form === 'card') {
    const number = digits(staged.cardNumber);
    if (number === '4000300011112220') throw businessError('Card declined');
    if (number === '4000100000000000' && amount > 10000) throw businessError('Card declined');
    return;
  }
  const routing = digits(staged.routingNumber);
  const account = digits(staged.accountNumber);
  if (routing === '000000000' || account === '0000000000') {
    throw businessError('Invalid bank account');
  }
}

function firmIsActive(firm: FirmRecord): boolean {
  return firm.status === 'ACTIVE' && firm.isAcceptingPayments;
}

// ---------------------------------------------------------------------------
// Argument shapes (only what the app sends)
// ---------------------------------------------------------------------------

interface CreateFirmArgs {
  input?: { name?: string | null; mockOnboarding?: boolean | null } | null;
}

interface CreatePaymentTokenArgs {
  input?: { bankAccountId?: string | null; paymentLinkId?: string | null } | null;
}

interface CreateSavePaymentMethodTokenArgs {
  input?: { clientId?: string | null } | null;
}

interface PaymentSessionCompleteArgs {
  input: {
    amount: number;
    clientId?: string | null;
    externalId?: string | null;
    method: PaymentSessionMethod;
    payerEmail?: string | null;
    payerName?: string | null;
    paymentSessionToken: string;
    savePaymentMethod?: boolean | null;
    sendReceipt?: boolean | null;
  };
}

interface CompleteSavePaymentMethodArgs {
  input: {
    clientId?: string | null;
    payerEmail?: string | null;
    payerName?: string | null;
    paymentMethod?: string | null;
    savePaymentMethodToken: string;
  };
}

interface AddClientArgs {
  input: { clientName: string; firmId?: string | null };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export const resolvers = {
  Query: {
    /** GetMyPartner — `me { partner { id appId } }`. */
    me(_parent: unknown, _args: unknown, ctx: MockContext): Record<string, unknown> {
      if (ctx.auth.kind === 'partner') {
        const partner = store.getPartner();
        return {
          role: 'partner',
          partner: { id: partner.id, appId: partner.appId },
          firm: null,
          paymentSession: null,
        };
      }
      // A firm token yields a Scope with no partner (PLAN.md §0.1).
      const firm = ctx.auth.firmId ? store.getFirm(ctx.auth.firmId) : undefined;
      return {
        role: 'firm',
        partner: null,
        firm: firm ? { id: firm.id, name: firm.name } : null,
        paymentSession: null,
      };
    },

    /** GetFirm — `firm { id isAcceptingPayments name }`. */
    firm(
      _parent: unknown,
      args: { id?: string | null },
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      if (args && args.id && args.id !== firm.id) {
        throw userInputError(`Firm with id(${args.id}) not found.`);
      }
      return firmShape(firm);
    },

    /** GetClient — `client(id) { id clientName email phone }`. */
    client(
      _parent: unknown,
      args: { id?: string | null; externalId?: string | null },
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      const id = args && args.id ? args.id : '';
      const client = id ? store.getClient(id) : undefined;
      if (!client || client.firmId !== firm.id) {
        throw userInputError(`Client with id(${id}) not found.`);
      }
      return clientShape(client);
    },

    /** PayRequestList — `payRequestList(input) { externalId transactions { id status_v2 } }`. */
    payRequestList(
      _parent: unknown,
      args: { input: { externalId: string; firmId?: string | null } },
      ctx: MockContext,
    ): Array<Record<string, unknown>> {
      const firm = requireFirm(ctx);
      const input = args.input;
      if (input.firmId && input.firmId !== firm.id) return [];
      const externalId = input.externalId;
      if (!externalId) return [];
      return store.findPaymentsByExternalId(firm.id, externalId).map((payment) => ({
        externalId: payment.externalId ?? externalId,
        transactions: payment.transactions.map(transactionShape),
      }));
    },
  },

  Mutation: {
    /** CreateFirm — partner only. `mockOnboarding:false` → CREATED / not accepting. */
    createFirm(
      _parent: unknown,
      args: CreateFirmArgs,
      ctx: MockContext,
    ): Record<string, unknown> {
      requirePartner(ctx);
      const input = args.input ?? {};
      const active = input.mockOnboarding === true;
      const firm = store.createFirm({ name: input.name ?? undefined, active });
      const apiToken = store.issueFirmToken(firm.id);
      const onboarding = store.createOnboardingToken(firm.id);
      const signUpLink = store.createSignUpLink(firm.id);
      return {
        ...firmShape(firm),
        apiToken,
        onboardingToken: { token: onboarding.token, expiresAt: onboarding.expiresAt },
        signUpLink: { link: signUpLink.link, expiresAt: signUpLink.expiresAt },
      };
    },

    /** CreateFirmSignUpLink — firm only. */
    createFirmSignUpLink(
      _parent: unknown,
      args: { firmId?: string | null },
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      if (args && args.firmId && args.firmId !== firm.id) {
        throw userInputError(`Firm with id(${args.firmId}) not found.`);
      }
      const record = store.createSignUpLink(firm.id);
      return { link: record.link, expiresAt: record.expiresAt };
    },

    /** CreateOnboardingToken — firm only. */
    createOnboardingToken(
      _parent: unknown,
      _args: unknown,
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      const record = store.createOnboardingToken(firm.id);
      return { token: record.token, expiresAt: record.expiresAt };
    },

    /** ExchangedCodeForFirmToken — partner only, one-time code. */
    exchangeCodeForFirmApiToken(
      _parent: unknown,
      args: { code: string },
      ctx: MockContext,
    ): string {
      requirePartner(ctx);
      const firmId = store.consumeConnectCode(args.code);
      if (!firmId) throw businessError('Invalid or expired code');
      return store.issueFirmToken(firmId);
    },

    /** DisconnectFromPartner — revokes the calling token immediately. */
    disconnectFromPartner(
      _parent: unknown,
      _args: { firmId?: string | null },
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      if (ctx.auth.token) store.revokeToken(ctx.auth.token);
      return firmShape(firm);
    },

    /** CreatePaymentToken — firm only. */
    createPaymentToken(
      _parent: unknown,
      args: CreatePaymentTokenArgs,
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      const input = args.input ?? {};
      let paymentLink: PaymentLinkRecord | undefined;
      if (input.paymentLinkId) {
        // The real API 404s the Paylinks page's hardcoded id unless the paylink
        // exists, active firm or not (PLAN.md §0.1).
        paymentLink = store.getPaylink(input.paymentLinkId);
        if (!paymentLink) throw businessError('Paylink not found');
      }
      if (!firmIsActive(firm)) throw businessError('no operating accounts exist');
      const session = store.createSession({
        kind: 'payment',
        firmId: firm.id,
        paymentLink,
      });
      return { paymentToken: session.token };
    },

    /** CreateSavePaymentMethodToken — firm only, firm must be active. */
    createSavePaymentMethodToken(
      _parent: unknown,
      args: CreateSavePaymentMethodTokenArgs,
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      if (!firmIsActive(firm)) throw businessError('This firm is not active.');
      const input = args.input ?? {};
      const session = store.createSession({
        kind: 'spm',
        firmId: firm.id,
        clientId: input.clientId ?? undefined,
      });
      return {
        savePaymentMethodToken: session.token,
        expiresAt: session.expiresAt,
        achProcessor: 'mock',
        ccProcessor: 'mock',
      };
    },

    /** PaymentSessionComplete — the decision table in PLAN.md §3.3. */
    paymentSessionComplete(
      _parent: unknown,
      args: PaymentSessionCompleteArgs,
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      const input = args.input;
      const session: SessionRecord | undefined = store.getSession(input.paymentSessionToken);
      if (!session || session.kind !== 'payment' || session.firmId !== firm.id) {
        throw businessError('PaymentSession not found');
      }
      if (session.used) throw businessError('Payment session already completed');

      const staged = session.staged;
      const method: PaymentSessionMethod = input.method;
      if (!staged) {
        if (method === 'CREDIT' || method === 'DEBIT') {
          throw businessError('binData is required for card payments');
        }
        throw businessError('No payment method submitted for this session');
      }

      const amount = Number(input.amount ?? 0);
      assertInstrumentAccepted(staged, amount);

      const now = new Date().toISOString();
      const cardBrand = brandOf(staged);
      const lastFour = lastFourOf(staged);
      const paymentMethod = txnMethodOf(staged, method);
      const externalId = input.externalId ?? null;
      const payerName = input.payerName ?? null;
      const payerEmail = input.payerEmail ?? null;

      let spm: SpmRecord | null = null;
      if (input.savePaymentMethod === true) {
        spm = store.createSpm({
          firmId: firm.id,
          lastFour,
          cardBrand,
          paymentMethod,
          payerName,
          payerEmail,
          clientId: input.clientId ?? null,
        });
      }

      const transaction: TransactionRecord = {
        id: store.newTransactionId(),
        amountProcessed: amount,
        status_v2: 'SUCCESSFUL',
        paymentMethod,
        externalId,
        lastFour,
        cardBrand,
        payerName,
        payerEmail,
        createdAt: now,
      };

      const payment: PaymentRecord = {
        id: store.newPaymentId(),
        firmId: firm.id,
        externalId,
        status: 'success',
        amount,
        method,
        cardBrand,
        transactions: [transaction],
        storedPaymentMethodId: spm ? spm.id : null,
        payerName,
        payerEmail,
        sendReceipt: input.sendReceipt ?? null,
        savePaymentMethod: input.savePaymentMethod === true,
        createdAt: now,
      };
      store.recordPayment(payment);
      store.markSessionUsed(session.token);

      return {
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        cardBrand: payment.cardBrand,
        createdOn: now,
        storedPaymentMethod: spm ? spmShape(spm) : null,
        transactions: [transactionShape(transaction)],
      };
    },

    /** CompleteSavePaymentMethod — `{ id lastFour }`. */
    completeSavePaymentMethod(
      _parent: unknown,
      args: CompleteSavePaymentMethodArgs,
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      const input = args.input;
      const session: SessionRecord | undefined = store.getSession(input.savePaymentMethodToken);
      if (!session || session.kind !== 'spm' || session.firmId !== firm.id) {
        throw businessError('SavePaymentMethodSession not found');
      }
      if (session.used) throw businessError('Payment session already completed');
      const staged = session.staged;
      if (!staged) throw businessError('No payment method submitted for this session');

      const spm = store.createSpm({
        firmId: firm.id,
        lastFour: lastFourOf(staged),
        cardBrand: brandOf(staged),
        paymentMethod: staged.form === 'card' ? staged.paymentMethod : 'ACH',
        payerName: input.payerName ?? null,
        payerEmail: input.payerEmail ?? null,
        clientId: input.clientId ?? session.clientId ?? null,
      });
      store.markSessionUsed(session.token);
      return spmShape(spm);
    },

    /** AddClient — `firmId` must be the token's firm (PLAN.md §0.1). */
    addClient(
      _parent: unknown,
      args: AddClientArgs,
      ctx: MockContext,
    ): Record<string, unknown> {
      const firm = requireFirm(ctx);
      const input = args.input;
      if (input.firmId && input.firmId !== firm.id) {
        throw userInputError(`Firm with id(${input.firmId}) not found.`);
      }
      const client = store.addClient(firm.id, input.clientName);
      return clientShape(client);
    },
  },
};

export default resolvers;
