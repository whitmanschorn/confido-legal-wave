/**
 * Test instruments, named so specs read like Confido's own sandbox docs.
 *
 * These are the values the mock's `paymentSessionComplete` decision table keys
 * off (PLAN.md §3.3). They are documented test numbers — no real card, no real
 * bank account, and nothing here is a credential.
 */

import type { PaymentSessionMethod } from '../mock-server/types';

export interface TestCard {
  /** The PAN to type into the hosted `Card Number` field. */
  number: string;
  /** `Exp` field, MM/YY. */
  exp: string;
  /** `CVV` field. */
  cvv: string;
  /** Brand the shim derives from the leading digit. */
  brand: 'visa' | 'mastercard' | 'amex' | 'discover';
  /** Last four, as it comes back on the transaction / stored payment method. */
  lastFour: string;
  /** What the mock records as the session method. */
  paymentMethod: Extract<PaymentSessionMethod, 'CREDIT' | 'DEBIT'>;
  /** Whether the mock approves the payment. */
  outcome: 'success' | 'declined' | 'conditional';
  /**
   * Only set for `outcome: 'conditional'` — the card declines when the amount
   * in cents is strictly greater than this.
   */
  declinesOverCents?: number;
  /** Human description, useful in test titles. */
  description: string;
}

export interface TestBankAccount {
  routingNumber: string;
  accountNumber: string;
  accountHolderName: string;
  lastFour: string;
  paymentMethod: Extract<PaymentSessionMethod, 'ACH'>;
  outcome: 'success' | 'declined';
  description: string;
}

/**
 * The threshold used by `CARDS.declinedOverLimit`: at or below it the payment
 * succeeds, above it the mock declines (PLAN.md §3.3).
 */
export const DECLINE_LIMIT_CENTS = 10_000;

export const CARDS = {
  /** The everyday happy path. */
  visaSuccess: {
    number: '4242424242424242',
    exp: '12/34',
    cvv: '123',
    brand: 'visa',
    lastFour: '4242',
    paymentMethod: 'CREDIT',
    outcome: 'success',
    description: 'Visa credit — approved',
  } as TestCard,

  /** Approved, but recorded as a DEBIT card rather than CREDIT. */
  debitSuccess: {
    number: '4000056655665556',
    exp: '12/34',
    cvv: '123',
    brand: 'visa',
    lastFour: '5556',
    paymentMethod: 'DEBIT',
    outcome: 'success',
    description: 'Visa debit — approved as DEBIT',
  } as TestCard,

  /**
   * Mastercard, approved. Used by the brand-icon assertions: the shim maps a
   * leading `5` or `2` to mastercard, and `CreditCardBrandIcon` renders the
   * mastercard SVG (distinguish by `path[fill="#D9222A"]`).
   */
  mastercardSuccess: {
    number: '5555555555554444',
    exp: '12/34',
    cvv: '123',
    brand: 'mastercard',
    lastFour: '4444',
    paymentMethod: 'CREDIT',
    outcome: 'success',
    description: 'Mastercard credit — approved',
  } as TestCard,

  /** Always declined, whatever the amount. */
  declined: {
    number: '4000300011112220',
    exp: '12/34',
    cvv: '123',
    brand: 'visa',
    lastFour: '2220',
    paymentMethod: 'CREDIT',
    outcome: 'declined',
    description: 'Visa — always declined',
  } as TestCard,

  /** Declined only above $100.00; approved at or below it. */
  declinedOverLimit: {
    number: '4000100000000000',
    exp: '12/34',
    cvv: '123',
    brand: 'visa',
    lastFour: '0000',
    paymentMethod: 'CREDIT',
    outcome: 'conditional',
    declinesOverCents: DECLINE_LIMIT_CENTS,
    description: 'Visa — declined over $100.00, approved at or below',
  } as TestCard,
} as const;

export const ACH = {
  /** Ordinary approved bank account. */
  valid: {
    routingNumber: '110000000',
    accountNumber: '000123456789',
    accountHolderName: 'Ada Lovelace',
    lastFour: '6789',
    paymentMethod: 'ACH',
    outcome: 'success',
    description: 'ACH — approved',
  } as TestBankAccount,

  /** Routing number the mock always rejects. */
  invalidRouting: {
    routingNumber: '000000000',
    accountNumber: '000123456789',
    accountHolderName: 'Ada Lovelace',
    lastFour: '6789',
    paymentMethod: 'ACH',
    outcome: 'declined',
    description: 'ACH — invalid routing number',
  } as TestBankAccount,

  /** Account number the mock always rejects. */
  invalidAccount: {
    routingNumber: '110000000',
    accountNumber: '0000000000',
    accountHolderName: 'Ada Lovelace',
    lastFour: '0000',
    paymentMethod: 'ACH',
    outcome: 'declined',
    description: 'ACH — invalid account number',
  } as TestBankAccount,
} as const;

/** Amounts the Payment Intents form takes, as the user types them. */
export const AMOUNTS = {
  /** $10.00 → 1000 cents. The default happy-path amount. */
  tenDollars: '10.00',
  /** $50.00 → 5000 cents. Under `DECLINE_LIMIT_CENTS`. */
  fiftyDollars: '50.00',
  /** $150.00 → 15000 cents. Over `DECLINE_LIMIT_CENTS`. */
  oneFiftyDollars: '150.00',
} as const;

/** `'10.00'` → `1000`. The app sends cents; the form takes dollars. */
export function dollarsToCents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/** `1000` → `'10.00'`. */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
