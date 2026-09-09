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
 * That gate is **not** a suppressed failure (PLAN.md §8.3): the six offline
 * tests below always run, they are the ones that would catch the mock drifting
 * from what the app actually sends, an `afterAll` proves the gated body did not
 * run, and the gated test states its opt-in condition in its own title so a
 * skip in the report is self-explanatory.
 *
 * ## What "fail only on breaking changes that touch our 14 operations" means
 *
 * The real SDL is ~4000 lines and the app uses a sliver of it. Comparing the
 * whole schema would fail on any unrelated Confido release. So the 14 operation
 * documents are **read out of `src/confido-legal-requests/` at run time** — not
 * copied into this file, where they could quietly drift from what the app
 * sends — the exact set of type/field coordinates they touch is derived from
 * them with `TypeInfo` (never hand-maintained), and only `findBreakingChanges`
 * entries naming one of those coordinates are fatal. Everything else — the rest
 * of the breaking changes and every dangerous change — is attached to the
 * report and logged.
 *
 * `validate()` only sees what a document *mentions*, so it cannot see the input
 * fields the app passes as JSON variables (`mockOnboarding`, `externalId`, …).
 * Those are listed separately, with the `src/` line that sends each one, and
 * checked against both schemas.
 *
 * As a second, sharper check the same 14 documents are `validate()`d against the
 * live schema: a document that no longer validates is drift by definition,
 * whatever `findBreakingChanges` decided to call it.
 */

import { readFileSync, readdirSync } from 'node:fs';
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
  isInputObjectType,
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
// The 14 operations the app sends, read out of the app's own source
// ---------------------------------------------------------------------------

/**
 * Every `gql` document under `src/confido-legal-requests/` is one operation the
 * app sends: the ten `index.ts` re-exports, plus `createOnboardingToken.ts` and
 * the two the Clients page calls straight from the browser (`addClient.ts`,
 * `getClient.ts`). Reading them from disk is the whole point — a copy in this
 * file would keep passing after someone edited a selection set in `src/`.
 */
const APP_REQUESTS_DIR = join(__dirname, '..', '..', 'src', 'confido-legal-requests');

/**
 * The wire `operationName`s the mock's event log records (PLAN.md §6). This is
 * the only hardcoded list left and it is an *assertion target*, never the
 * source of the documents: if the app gains, loses or renames an operation the
 * discovery test fails and names it.
 */
const EXPECTED_OPERATION_NAMES: string[] = [
  'AddClient',
  'CompleteSavePaymentMethod',
  'CreateFirm',
  'CreateFirmSignUpLink',
  'CreateOnboardingToken',
  'CreatePaymentToken',
  'CreateSavePaymentMethodToken',
  'DisconnectFromPartner',
  // The app's own typo: the operation is named `ExchangedCodeForFirmToken`
  // while the field it selects is `exchangeCodeForFirmApiToken`.
  'ExchangedCodeForFirmToken',
  'GetClient',
  'GetFirm',
  'GetMyPartner',
  'PayRequestList',
  'PaymentSessionComplete',
];

interface AppOperation {
  /** `operationName` on the wire, i.e. what `mock.events` records. */
  name: string | null;
  /** `src/confido-legal-requests/getFirm.ts:4` — where the document lives. */
  source: string;
  /** The text inside the gql`` template, verbatim. */
  document: string;
  /** Parsed form, or `null` when the document is not valid GraphQL at all. */
  ast: DocumentNode | null;
  parseError: string | null;
}

/**
 * `gql`…`` with no interpolation. Every document in the app is a plain
 * template literal, so a backtick-delimited grab is exact; if one ever gained a
 * `${}` the document would fail to parse and the discovery test would say so.
 */
const GQL_TEMPLATE = /\bgql`([^`]*)`/g;

function operationNameOf(ast: DocumentNode): string | null {
  const definitions = ast.definitions;
  for (let i = 0; i < definitions.length; i += 1) {
    const definition = definitions[i];
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      return definition.name ? definition.name.value : null;
    }
  }
  return null;
}

function toOperation(source: string, document: string): AppOperation {
  try {
    const ast = parse(document);
    return { name: operationNameOf(ast), source, document, ast, parseError: null };
  } catch (error) {
    return { name: null, source, document, ast: null, parseError: String(error) };
  }
}

/** Every gql`` document in `dir`, in filename order, tagged with `file:line`. */
function readGqlDocuments(dir: string, relative: string): AppOperation[] {
  const found: AppOperation[] = [];
  readdirSync(dir)
    .filter((file) => /\.tsx?$/.test(file))
    .sort()
    .forEach((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      GQL_TEMPLATE.lastIndex = 0;
      let match = GQL_TEMPLATE.exec(text);
      while (match !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        found.push(toOperation(`${relative}/${file}:${line}`, match[1]));
        match = GQL_TEMPLATE.exec(text);
      }
    });
  return found;
}

const APP_OPERATIONS: AppOperation[] = readGqlDocuments(
  APP_REQUESTS_DIR,
  'src/confido-legal-requests',
);

/**
 * Input-object fields the app sends as **variables**. No document mentions
 * them, so `validate()` is blind to them: `createFirm` would still validate
 * against a schema that had dropped `CreateFirmInput.mockOnboarding`, and the
 * app would still break. Hand-maintained on purpose, each with the line that
 * sends it.
 */
interface SentInputField {
  typeName: string;
  field: string;
  source: string;
}

const SENT_INPUT_FIELDS: SentInputField[] = [
  { typeName: 'CreateFirmInput', field: 'name', source: 'createFirm.ts:50' },
  { typeName: 'CreateFirmInput', field: 'mockOnboarding', source: 'createFirm.ts:51' },
  { typeName: 'AddClientInput', field: 'clientName', source: 'addClient.ts:40' },
  { typeName: 'AddClientInput', field: 'firmId', source: 'addClient.ts:41' },
  { typeName: 'PayRequestInput', field: 'externalId', source: 'pay-request-lookup.ts:31' },
  { typeName: 'PayRequestInput', field: 'firmId', source: 'pay-request-lookup.ts:32' },
  { typeName: 'CreatePaymentTokenInput', field: 'bankAccountId', source: 'createPaymentToken.ts:35' },
  { typeName: 'CreatePaymentTokenInput', field: 'paymentLinkId', source: 'createPaymentToken.ts:36' },
  { typeName: 'CreateSavePaymentMethodTokenInput', field: 'clientId', source: 'createSavePaymentMethodToken.ts:39' },
  { typeName: 'PaymentSessionCompleteInput', field: 'externalId', source: 'paymentSessionComplete.ts:87' },
  { typeName: 'PaymentSessionCompleteInput', field: 'amount', source: 'paymentSessionComplete.ts:34' },
  { typeName: 'PaymentSessionCompleteInput', field: 'method', source: 'paymentSessionComplete.ts:38' },
  { typeName: 'PaymentSessionCompleteInput', field: 'paymentSessionToken', source: 'paymentSessionComplete.ts:42' },
  { typeName: 'PaymentSessionCompleteInput', field: 'savePaymentMethod', source: 'paymentSessionComplete.ts:43' },
  { typeName: 'PaymentSessionCompleteInput', field: 'sendReceipt', source: 'paymentSessionComplete.ts:44' },
  { typeName: 'PaymentSessionCompleteInput', field: 'surchargeEnabled', source: 'paymentSessionComplete.ts:45' },
  { typeName: 'CompleteSavePaymentMethodSessionInput', field: 'savePaymentMethodToken', source: 'completeSavePaymentMethod.ts:22' },
  { typeName: 'CompleteSavePaymentMethodSessionInput', field: 'paymentMethod', source: 'completeSavePaymentMethod.ts:21' },
];

const DEAD_DOCUMENT_QUIRK =
  'src/components/transactions/useTransactions.ts:3-9 declares `query GET_TRANSACTIONS() ' +
  '{ transactions { } }` — an empty argument list and an empty selection set are both ' +
  'syntax errors, and `transactions` is not a field on Query in the real SDL either. It ' +
  'survives because `useTransactions` has no callers and gql`` only parses when evaluated, ' +
  'so @apollo/client is a dependency for one dead file. QUIRKS.md #12.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadMockSchema(): GraphQLSchema {
  return buildSchema(readFileSync(SCHEMA_PATH, 'utf8'));
}

/** The parsed documents, in `APP_OPERATIONS` order. Unparseable ones are dropped. */
function parsedDocuments(): DocumentNode[] {
  const documents: DocumentNode[] = [];
  APP_OPERATIONS.forEach((operation) => {
    if (operation.ast) documents.push(operation.ast);
  });
  return documents;
}

/**
 * `SENT_INPUT_FIELDS` entries the schema does not have. Empty means every field
 * the app puts in its variables still exists.
 */
function missingSentInputFields(schema: GraphQLSchema): string[] {
  const missing: string[] = [];
  SENT_INPUT_FIELDS.forEach((sent) => {
    const type = schema.getType(sent.typeName);
    if (!type || !isInputObjectType(type)) {
      missing.push(`${sent.typeName} is not an input object type (sent from ${sent.source})`);
      return;
    }
    const fields = type.getFields();
    if (!Object.prototype.hasOwnProperty.call(fields, sent.field)) {
      missing.push(`${sent.typeName}.${sent.field} is gone (sent from ${sent.source})`);
    }
  });
  return missing;
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

/**
 * Set by the gated test's body, checked by `afterAll`. Proves the gate really
 * gated, rather than only proving that the predicate behind it is correct.
 */
let liveIntrospectionBodyRan = false;

test.describe('contract drift', () => {
  test('the 14 operation documents are read from src/, not copied into this spec', () => {
    // Nothing in this test is a copy of the app's GraphQL: every document came
    // off disk a few milliseconds ago. Edit a selection set in
    // src/confido-legal-requests and the next run validates the edited one.
    const parseFailures = APP_OPERATIONS.filter((operation) => operation.parseError !== null).map(
      (operation) => `${operation.source}: ${operation.parseError}`,
    );
    expect(parseFailures, 'every gql`` document in the app must parse').toEqual([]);

    const names = APP_OPERATIONS.map((operation) => operation.name);
    expect(
      names.slice().sort(),
      'the operations the app sends are not the ones the mock implements',
    ).toEqual(EXPECTED_OPERATION_NAMES.slice().sort());
    expect(APP_OPERATIONS.length).toBe(14);

    // Spot-check the provenance: a real file, a real line, real text.
    const getFirm = APP_OPERATIONS.filter((operation) => operation.name === 'GetFirm')[0];
    expect(getFirm.source).toBe('src/confido-legal-requests/getFirm.ts:4');
    expect(getFirm.document).toContain('isAcceptingPayments');
    const addClient = APP_OPERATIONS.filter((operation) => operation.name === 'AddClient')[0];
    expect(addClient.source).toBe('src/confido-legal-requests/addClient.ts:4');
  });

  test('the checked-in SDL supports all 14 operations the app sends', () => {
    const schema = loadMockSchema();
    const failures: string[] = [];

    APP_OPERATIONS.forEach((operation) => {
      if (!operation.ast) {
        failures.push(`${operation.source} does not parse: ${operation.parseError}`);
        return;
      }
      validate(schema, operation.ast).forEach((error) => {
        failures.push(`${operation.name} (${operation.source}): ${error.message}`);
      });
    });

    expect(failures).toEqual([]);
    expect(APP_OPERATIONS.length).toBe(14);
  });

  test('the checked-in SDL also has the input fields the app only sends as variables', () => {
    // validate() cannot see these: `createFirm` validates fine against a schema
    // with no `CreateFirmInput.mockOnboarding`, and the app still breaks.
    expect(missingSentInputFields(loadMockSchema())).toEqual([]);
    expect(SENT_INPUT_FIELDS.length).toBeGreaterThan(0);
  });

  test(
    'the app\'s one other GraphQL document is dead and does not even parse',
    { annotation: { type: 'quirk', description: DEAD_DOCUMENT_QUIRK } },
    () => {
      // Why the scan above is scoped to src/confido-legal-requests: the app has
      // exactly one other gql`` document and it is a syntax error that survives
      // only because nothing ever evaluates it.
      const dead = readGqlDocuments(
        join(__dirname, '..', '..', 'src', 'components', 'transactions'),
        'src/components/transactions',
      );

      expect(dead.length).toBe(1);
      expect(dead[0].source).toBe('src/components/transactions/useTransactions.ts:3');
      expect(dead[0].parseError, 'GET_TRANSACTIONS unexpectedly parses now').toContain(
        'Syntax Error',
      );
      expect(dead[0].name).toBeNull();

      // …and it is not one of the 14, so it can never mask a real drift.
      APP_OPERATIONS.forEach((operation) => {
        expect(operation.source).not.toContain('useTransactions');
      });
    },
  );

  test('the derived "surface we care about" really is derived from the documents', () => {
    const schema = loadMockSchema();
    const documents = parsedDocuments();
    expect(documents.length).toBe(14);
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

  /**
   * The truth table above only proves the predicate. This proves the *gate*:
   * with the variable unset, the network-touching body must not have run. If
   * someone deleted or inverted the `test.skip` below, this fails — in the same
   * worker, right after the test that would have made the call.
   */
  test.afterAll(() => {
    if (!LIVE_INTROSPECTION) {
      expect(
        liveIntrospectionBodyRan,
        'the live-introspection body ran with CONFIDO_LIVE_INTROSPECT unset: the gate is ' +
          'broken and the suite just reached the public internet',
      ).toBe(false);
    }
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
          'offline tests in this file always run.',
      );
      liveIntrospectionBodyRan = true;

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

      const surface = usedSurface(mockSchema, parsedDocuments());

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
      APP_OPERATIONS.forEach((operation) => {
        if (!operation.ast) {
          validationFailures.push(`${operation.source} does not parse: ${operation.parseError}`);
          return;
        }
        validate(liveSchema, operation.ast).forEach((error) => {
          validationFailures.push(`${operation.name} (${operation.source}): ${error.message}`);
        });
      });
      missingSentInputFields(liveSchema).forEach((message) => {
        validationFailures.push(`variables: ${message}`);
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
