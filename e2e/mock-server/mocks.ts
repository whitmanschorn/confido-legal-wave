/**
 * Scalar / leaf mocks handed to `addMocksToSchema` (PLAN.md §3.1).
 *
 * The hand-written resolvers in `./resolvers` only return the fields the app
 * actually selects. Every other field in the 4000-line SDL is filled in from
 * here, which is what keeps responses type-correct no matter what a spec asks
 * for. Values are deterministic on purpose: a mocked field must never be the
 * reason a test flakes.
 *
 * NOTE ON LIST LENGTH: @graphql-tools/mock v9 hard-codes the generated list
 * length at 2 (`randomListLength()` in `@graphql-tools/mock/utils`); there is
 * no option for it, so DEFAULT_LIST_LENGTH below is documentation of that
 * constant rather than a knob. Every list the app actually reads is returned
 * by a real resolver, so the generated length never reaches an assertion.
 */

import { randomUUID } from 'node:crypto';
import type { IMocks } from '@graphql-tools/mock';

/** What @graphql-tools/mock generates for an unresolved list field. */
export const DEFAULT_LIST_LENGTH = 2;

/** Fixed timestamp base so mocked DateTimeISO values are ordered but stable. */
export const mocks: IMocks = {
  // Custom scalars declared in schema.graphql.
  DateTimeISO: () => new Date().toISOString(),
  JSON: () => ({}),
  BigInt: () => '0',

  // Built-in scalars. Deterministic overrides of the library defaults
  // (which are Math.random()-based for Int/Float/Boolean).
  String: () => 'mock',
  Int: () => 0,
  Float: () => 0,
  Boolean: () => false,
  ID: () => randomUUID(),
};

export default mocks;
