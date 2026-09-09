/**
 * Contract drift between `e2e/mock-server/schema.graphql` and the **live**
 * Confido sandbox schema (PLAN.md §6, `contract-drift.spec`).
 *
 * ## This file is opt-in, on purpose
 *
 * The whole point of the suite is that it is green on a clean clone with no
 * credentials and no network. This one check needs network — Confido leaves
 * introspection open, so it needs no credentials, but it does need to reach
 * `api.sandbox.gravity-legal.com`. So the live comparison only runs when
 * `CONFIDO_LIVE_INTROSPECT=1`, mirroring
 * `e2e/mock-server/scripts/refresh-schema.ts`, and CI never sets it.
 *
 * That gate is **not** a suppressed failure (PLAN.md §8.3): the two offline
 * tests below always run, they are the ones that would catch the mock drifting
 * from what the app actually sends, and the third test states its opt-in
 * condition in its own title so a skip in the report is self-explanatory.
 *
 * ## What "fail only on breaking changes that touch our 14 operations" means
 *
 * The real SDL is ~4000 lines and the app uses a sliver of it. Comparing the
 * whole schema would fail on any unrelated Confido release. So the 14 operation
 * documents the app actually sends are reproduced here verbatim, the exact set
 * of type/field coordinates they touch is derived from them with `TypeInfo`
 * (never hand-maintained), and only `findBreakingChanges` entries naming one of
 * those coordinates are fatal. Everything else — the rest of the breaking
 * changes and every dangerous change — is attached to the report and logged.
 *
 * As a second, sharper check the same 14 documents are `validate()`d against the
 * live schema: a document that no longer validates is drift by definition,
 * whatever `findBreakingChanges` decided to call it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DocumentNode,
  GraphQLSchema,
  IntrospectionQuery,
  NamedTypeNode,
} from 'graphql';
import {
  Kind,
  TypeInfo,
  buildClientSchema,
  buildSchema,
  findBreakingChanges,
  findDangerousChanges,
  parse,
  printSchema,
  validate,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../fixtures/test';

/** Same default and same override as `mock-server/scripts/refresh-schema.ts`. */
const DEFAULT_INTROSPECT_ENDPOINT = 'https://api.sandbox.gravity-legal.com/v2';

const SCHEMA_PATH = join(__dirname, '..', 'mock-server', 'schema.graphql');

/**
 * The gate, as a pure function so the "unset" behaviour is testable without
 * touching the network.
 */
export function liveIntrospectionEnabled(value: string | undefined): boolean {
  return value === '1';
}

const LIVE_INTROSPECTION = liveIntrospectionEnabled(
  process.env.CONFIDO_LIVE_INTROSPECT,
);

const INTROSPECT_ENDPOINT =
  process.env.CONFIDO_INTROSPECT_ENDPOINT ?? DEFAULT_INTROSPECT_ENDPOINT;

// ---------------------------------------------------------------------------
// The 14 operations the app sends, copied verbatim from src/
// ---------------------------------------------------------------------------

interface AppOperation {
  /** `operationName` on the wire, i.e. what `mock.events` records. */
  name: string;
  /** Where the document lives in the app. */
  source: string;
  document: string;
}

const APP_OPERATIONS: AppOperation[] = [
  {
    name: 'GetMyPartner',
    source: 'src/confido-legal-requests/getMyPartner.ts',
    document: `
      query GetMyPartner {
        me {
          partner {
            id
            appId
          }
        }
      }
    `,
  },
  {
    name: 'GetFirm',
    source: 'src/confido-legal-requests/getFirm.ts',
    document: `
      query GetFirm {
        firm {
          id
          isAcceptingPayments
          name
        }
      }
    `,
  },
  {
    name: 'GetClient',
    source: 'src/confido-legal-requests/getClient.ts',
    document: `
      query GetClient($id: String!) {
        client(id: $id) {
          id
          clientName
          email
          phone
        }
      }
    `,
  },
  {
    name: 'PayRequestList',
    source: 'src/confido-legal-requests/payRequestList.ts',
    document: `
      query PayRequestList($input: PayRequestInput!) {
        payRequestList(input: $input) {
          externalId
          transactions {
            id
            status_v2
          }
        }
      }
    `,
  },
  {
    name: 'CreateFirm',
    source: 'src/confido-legal-requests/createFirm.ts',
    document: `
      mutation CreateFirm($input: CreateFirmInput!) {
        createFirm(input: $input) {
          apiToken
          onboardingToken {
            expiresAt
            token
          }
          signUpLink {
            link
            expiresAt
          }
        }
      }
    `,
  },
  {
    name: 'CreateFirmSignUpLink',
    source: 'src/confido-legal-requests/createFirmSignUpLink.ts',
    document: `
      mutation CreateFirmSignUpLink {
        createFirmSignUpLink {
          link
          expiresAt
        }
      }
    `,
  },
  {
    name: 'CreateOnboardingToken',
    source: 'src/confido-legal-requests/createOnboardingToken.ts',
    document: `
      mutation CreateOnboardingToken {
        createOnboardingToken {
          expiresAt
          token
        }
      }
    `,
  },
  {
    // The app's own typo: the operation is named `ExchangedCodeForFirmToken`
    // while the field is `exchangeCodeForFirmApiToken`.
    name: 'ExchangedCodeForFirmToken',
    source: 'src/confido-legal-requests/exchangeCodeForFirmToken.ts',
    document: `
      mutation ExchangedCodeForFirmToken($code: String!) {
        exchangeCodeForFirmApiToken(code: $code)
      }
    `,
  },
  {
    name: 'DisconnectFromPartner',
    source: 'src/confido-legal-requests/disconnect.ts',
    document: `
      mutation DisconnectFromPartner {
        disconnectFromPartner {
          id
        }
      }
    `,
  },
  {
    name: 'CreatePaymentToken',
    source: 'src/confido-legal-requests/createPaymentToken.ts',
    document: `
      mutation CreatePaymentToken($input: CreatePaymentTokenInput) {
        createPaymentToken(input: $input) {
          paymentToken
        }
      }
    `,
  },
  {
    name: 'CreateSavePaymentMethodToken',
    source: 'src/confido-legal-requests/createSavePaymentMethodToken.ts',
    document: `
      mutation CreateSavePaymentMethodToken($input: CreateSavePaymentMethodTokenInput) {
        createSavePaymentMethodToken(input: $input) {
          savePaymentMethodToken
        }
      }
    `,
  },
  {
    name: 'PaymentSessionComplete',
    source: 'src/confido-legal-requests/paymentSessionComplete.ts',
    document: `
      mutation PaymentSessionComplete($input: PaymentSessionCompleteInput!) {
        paymentSessionComplete(input: $input) {
          id
          status
          storedPaymentMethod {
            cardBrand
            payerName
            paymentMethod
            lastFour
            id
          }
          transactions {
            id
            amountProcessed
            payRequest {
              externalId
            }
          }
        }
      }
    `,
  },
  {
    name: 'CompleteSavePaymentMethod',
    source: 'src/confido-legal-requests/completeSavePaymentMethod.ts',
    document: `
      mutation CompleteSavePaymentMethod($input: CompleteSavePaymentMethodSessionInput!) {
        completeSavePaymentMethod(input: $input) {
          id
          lastFour
        }
      }
    `,
  },
  {
    name: 'AddClient',
    source: 'src/confido-legal-requests/addClient.ts',
    document: `
      mutation AddClient($input: AddClientInput!) {
        addClient(input: $input) {
          clientName
          id
        }
      }
    `,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadMockSchema(): GraphQLSchema {
  return buildSchema(readFileSync(SCHEMA_PATH, 'utf8'));
}

function push(list: string[], value: string): void {
  if (list.indexOf(value) === -1) list.push(value);
}

interface UsedSurface {
  /** `Query.firm`, `Firm.isAcceptingPayments`, … */
  coordinates: string[];
  /** `Firm`, `AddClientInput`, `PaymentStatus`, … */
  typeNames: string[];
}

/**
 * The exact slice of the schema the 14 documents touch, derived from the
 * documents themselves so it can never go stale.
 */
function usedSurface(schema: GraphQLSchema, documents: DocumentNode[]): UsedSurface {
  const coordinates: string[] = [];
  const typeNames: string[] = [];

  documents.forEach((document) => {
    const typeInfo = new TypeInfo(schema);
    visit(
      document,
      visitWithTypeInfo(typeInfo, {
        Field(node) {
          const parent = typeInfo.getParentType();
          if (parent) {
            push(coordinates, `${parent.name}.${node.name.value}`);
            push(typeNames, parent.name);
          }
          const fieldType = typeInfo.getType();
          if (fieldType) push(typeNames, namedTypeName(String(fieldType)));
        },
        // Variable definitions carry the input types the app sends as JSON;
        // TypeInfo does not walk into them, so pick the names up here.
        NamedType(node: NamedTypeNode) {
          push(typeNames, node.name.value);
        },
      }),
    );
  });

  return { coordinates, typeNames };
}

/** `[Transaction!]!` → `Transaction`. */
function namedTypeName(printed: string): string {
  return printed.replace(/[[\]!]/g, '');
}

/** Whole-identifier match, so `Firm` does not match `FirmStatus`. */
function mentions(description: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_.]|$)`).test(description);
}

function touchesUsedSurface(description: string, surface: UsedSurface): boolean {
  let hit = false;
  surface.coordinates.forEach((coordinate) => {
    if (!hit && description.indexOf(coordinate) !== -1) hit = true;
  });
  if (hit) return true;
  surface.typeNames.forEach((typeName) => {
    if (!hit && mentions(description, typeName)) hit = true;
  });
  return hit;
}

async function introspectLiveSchema(
  request: APIRequestContext,
  endpoint: string,
): Promise<GraphQLSchema> {
  // Uses the worker-scoped `request` fixture, which is a separate
  // APIRequestContext from the browser: the `lockdown` route never sees it, so
  // this is the one place in the suite that is *meant* to reach the network.
  const { getIntrospectionQuery } = await import('graphql');
  const response = await request.post(endpoint, {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    data: {
      operationName: 'IntrospectionQuery',
      query: getIntrospectionQuery({ descriptions: true }),
    },
    timeout: 60_000,
  });

  expect(
    response.status(),
    `introspection of ${endpoint} failed: ${(await response.text()).slice(0, 400)}`,
  ).toBe(200);

  const payload = (await response.json()) as {
    data?: IntrospectionQuery;
    errors?: Array<{ message?: string }>;
  };
  expect(payload.errors ?? [], 'introspection returned GraphQL errors').toEqual([]);
  expect(payload.data, 'introspection returned no data').toBeTruthy();

  return buildClientSchema(payload.data as IntrospectionQuery);
}

// ---------------------------------------------------------------------------
// Always-on, offline
// ---------------------------------------------------------------------------

test.describe('contract drift', () => {
  test('the checked-in SDL supports all 14 operations the app sends', () => {
    const schema = loadMockSchema();
    const failures: string[] = [];

    APP_OPERATIONS.forEach((operation) => {
      let document: DocumentNode;
      try {
        document = parse(operation.document);
      } catch (error) {
        failures.push(`${operation.name} (${operation.source}) does not parse: ${String(error)}`);
        return;
      }
      const errors = validate(schema, document);
      errors.forEach((error) => {
        failures.push(`${operation.name} (${operation.source}): ${error.message}`);
      });
    });

    expect(failures).toEqual([]);
    expect(APP_OPERATIONS.length).toBe(14);
  });

  test('the derived "surface we care about" really is derived from the documents', () => {
    const schema = loadMockSchema();
    const documents = APP_OPERATIONS.map((operation) => parse(operation.document));
    const surface = usedSurface(schema, documents);

    // Spot-checks: one root field per token kind, one nested field, one input.
    expect(surface.coordinates).toContain('Query.me');
    expect(surface.coordinates).toContain('Query.firm');
    expect(surface.coordinates).toContain('Mutation.createFirm');
    expect(surface.coordinates).toContain('Mutation.exchangeCodeForFirmApiToken');
    expect(surface.coordinates).toContain('Firm.isAcceptingPayments');
    expect(surface.typeNames).toContain('AddClientInput');
    expect(surface.typeNames).toContain('PaymentSessionCompleteInput');

    // …and a field the app never selects must NOT be in the fatal set, or the
    // filter would be useless and every unrelated Confido release would fail.
    expect(surface.coordinates).not.toContain('Query.bankAccountsList');
    expect(touchesUsedSurface('BankAccount.nickname was removed.', surface)).toBe(false);
    expect(touchesUsedSurface('Firm.isAcceptingPayments was removed.', surface)).toBe(true);
  });

  test('the live-introspection gate is closed unless CONFIDO_LIVE_INTROSPECT=1', () => {
    expect(liveIntrospectionEnabled(undefined)).toBe(false);
    expect(liveIntrospectionEnabled('')).toBe(false);
    expect(liveIntrospectionEnabled('0')).toBe(false);
    expect(liveIntrospectionEnabled('true')).toBe(false);
    expect(liveIntrospectionEnabled('1')).toBe(true);

    // Whatever the environment happens to be, the constant the gated test uses
    // agrees with the pure function.
    expect(LIVE_INTROSPECTION).toBe(
      liveIntrospectionEnabled(process.env.CONFIDO_LIVE_INTROSPECT),
    );
  });

  // -------------------------------------------------------------------------
  // Opt-in, needs network
  // -------------------------------------------------------------------------

  test(
    'OPT-IN (CONFIDO_LIVE_INTROSPECT=1): the live sandbox schema has not broken our 14 operations',
    {
      annotation: {
        type: 'opt-in',
        description:
          'Runs only with CONFIDO_LIVE_INTROSPECT=1. Introspects ' +
          `${DEFAULT_INTROSPECT_ENDPOINT} (introspection is open, no credentials needed) and ` +
          'diffs it against e2e/mock-server/schema.graphql. Report-only for everything ' +
          'outside the 14 operations the app sends. CI never sets the variable, so the ' +
          'credential-free, network-free guarantee is unaffected.',
      },
    },
    async ({ request }, testInfo) => {
      test.skip(
        !LIVE_INTROSPECTION,
        'Opt-in: set CONFIDO_LIVE_INTROSPECT=1 to introspect the live Confido sandbox. ' +
          'This is a gate on a network-requiring check, not a suppressed failure — the ' +
          'three offline tests in this file always run.',
      );

      const mockSchema = loadMockSchema();
      const liveSchema = await introspectLiveSchema(request, INTROSPECT_ENDPOINT);

      const livePrinted = printSchema(liveSchema);
      await testInfo.attach('live-schema.graphql', {
        contentType: 'text/plain',
        body: livePrinted,
      });

      // Old = what the harness was built against, new = what is live now, so
      // "breaking" reads as "would break the mock's consumers".
      const breaking = findBreakingChanges(mockSchema, liveSchema);
      const dangerous = findDangerousChanges(mockSchema, liveSchema);

      await testInfo.attach('schema-diff.json', {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            endpoint: INTROSPECT_ENDPOINT,
            checkedAt: new Date().toISOString(),
            breakingChangeCount: breaking.length,
            dangerousChangeCount: dangerous.length,
            breakingChanges: breaking,
            dangerousChanges: dangerous,
          },
          null,
          2,
        ),
      });

      const documents = APP_OPERATIONS.map((operation) => parse(operation.document));
      const surface = usedSurface(mockSchema, documents);

      const relevant = breaking.filter((change) =>
        touchesUsedSurface(change.description, surface),
      );
      const informational = breaking.filter(
        (change) => !touchesUsedSurface(change.description, surface),
      );

      // Report everything; fail on nothing but the relevant set.
      console.log(
        `[contract-drift] ${INTROSPECT_ENDPOINT}: ${breaking.length} breaking, ` +
          `${dangerous.length} dangerous; ${relevant.length} touch the 14 operations.`,
      );
      informational.forEach((change) => {
        console.log(`[contract-drift] (report-only) ${change.type}: ${change.description}`);
      });
      dangerous.forEach((change) => {
        console.log(`[contract-drift] (dangerous)   ${change.type}: ${change.description}`);
      });

      // The sharper check: the app's own documents must still validate.
      const validationFailures: string[] = [];
      APP_OPERATIONS.forEach((operation, index) => {
        validate(liveSchema, documents[index]).forEach((error) => {
          validationFailures.push(`${operation.name} (${operation.source}): ${error.message}`);
        });
      });

      expect(
        validationFailures,
        'the app\'s GraphQL documents no longer validate against the live sandbox schema',
      ).toEqual([]);
      expect(
        relevant.map((change) => `${change.type}: ${change.description}`),
        'breaking schema changes that touch the 14 operations the mock implements',
      ).toEqual([]);
    },
  );
});

// Keeps `Kind` imported for the visitor's benefit under `isolatedModules`
// without an unused-import warning; the value is never branched on.
void Kind;
