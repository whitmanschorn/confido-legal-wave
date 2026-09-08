/**
 * GraphQL mount point for the mock Confido API (PLAN.md §3.1).
 *
 * The real SDL (`./schema.graphql`, dumped by unauthenticated introspection of
 * the sandbox) is turned into an executable schema with the hand-written
 * resolvers from `./resolvers`, then every field those resolvers do not answer
 * is auto-mocked, so the response is always type-correct for whatever the app
 * selects.
 *
 * Auth is handled here rather than inside yoga because two of the three
 * failure modes are pre-execution HTTP 500s in the real API (PLAN.md §0.1) and
 * must not carry a `data` key.
 *
 * Every operation — success or failure, including the auth short-circuits — is
 * appended to the event log so specs can wait on server-side calls instead of
 * sleeping.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Kind, parse } from 'graphql';
import type { OperationDefinitionNode } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { addMocksToSchema } from '@graphql-tools/mock';
import { createYoga } from 'graphql-yoga';
import type { YogaInitialContext } from 'graphql-yoga';
import { mocks } from './mocks';
import {
  ACCESS_DENIED_MESSAGE,
  INVALID_TOKEN_MESSAGE,
  REVOKED_TOKEN_MESSAGE,
  resolvers,
} from './resolvers';
import type { MockContext } from './resolvers';
import { recordEvent } from './events';
import * as store from './store';
import type { TokenKind } from './types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** CommonJS at runtime (tsx), so `__dirname` — never `import.meta.url`. */
export const SCHEMA_PATH = join(__dirname, 'schema.graphql');

const typeDefs = readFileSync(SCHEMA_PATH, 'utf8');

export const schema = addMocksToSchema({
  schema: makeExecutableSchema({ typeDefs, resolvers }),
  mocks,
  preserveResolvers: true,
  // Enum / abstract-type picks become the first member instead of a random
  // one, so an unselected field can never make a spec flaky.
  mockGenerationBehavior: 'deterministic',
});

// ---------------------------------------------------------------------------
// Yoga
// ---------------------------------------------------------------------------

/**
 * Mounted at a single internal path; `handleGraphQL` rewrites every incoming
 * URL (`/v2`, `/graphql`, `POST /`) to it, so the public mount points are
 * decided by `isGraphQLPath` alone.
 */
const YOGA_ENDPOINT = '/graphql';

const yoga = createYoga<Record<string, never>, MockContext>({
  schema,
  graphqlEndpoint: YOGA_ENDPOINT,
  // The app must see Confido's error text verbatim.
  maskedErrors: false,
  landingPage: false,
  logging: false,
  cors: {
    origin: '*',
    credentials: false,
    allowedHeaders: ['content-type', 'accept', 'x-api-key', 'authorization'],
    methods: ['GET', 'POST', 'OPTIONS'],
  },
  context: (initial: YogaInitialContext): MockContext => ({
    auth: store.resolveToken(initial.request.headers.get('x-api-key')),
  }),
});

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export function isGraphQLPath(pathname: string): boolean {
  return pathname === '/v2' || pathname === '/graphql';
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept, x-api-key, authorization',
    'access-control-max-age': '86400',
  };
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  const headers = corsHeaders();
  headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // String chunks, not Buffers: the root tsconfig type-checks this file
    // against a different @types/node than e2e/ does, and their Buffer types
    // are not assignable to each other. setEncoding keeps multi-byte UTF-8
    // sequences intact across chunk boundaries.
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

interface ParsedRequest {
  query: string | null;
  operationName: string | null;
  variables: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseRequest(req: IncomingMessage, rawBody: string): ParsedRequest {
  const result: ParsedRequest = { query: null, operationName: null, variables: {} };

  if (rawBody) {
    try {
      const body = asRecord(JSON.parse(rawBody));
      if (typeof body.query === 'string') result.query = body.query;
      if (typeof body.operationName === 'string') result.operationName = body.operationName;
      result.variables = asRecord(body.variables);
      return result;
    } catch (error) {
      // Fall through to the query string; a malformed body is yoga's problem.
    }
  }

  const raw = req.url ?? '';
  const q = raw.indexOf('?');
  if (q !== -1) {
    const params = new URLSearchParams(raw.slice(q + 1));
    result.query = params.get('query');
    result.operationName = params.get('operationName');
    const variables = params.get('variables');
    if (variables) {
      try {
        result.variables = asRecord(JSON.parse(variables));
      } catch (error) {
        result.variables = {};
      }
    }
  }
  return result;
}

interface OperationInfo {
  operationName: string | null;
  /** Root field aliases, used for the `path` on the access-denied error. */
  rootFields: string[];
}

/**
 * graphql-request does send `operationName`, but the browser-side calls and
 * hand-rolled requests in specs may not, so fall back to the document.
 */
function analyzeOperation(query: string | null, explicitName: string | null): OperationInfo {
  const info: OperationInfo = { operationName: explicitName, rootFields: [] };
  if (!query) return info;

  let operation: OperationDefinitionNode | undefined;
  try {
    const document = parse(query);
    document.definitions.forEach((definition) => {
      if (operation) return;
      if (definition.kind !== Kind.OPERATION_DEFINITION) return;
      if (explicitName && (!definition.name || definition.name.value !== explicitName)) return;
      operation = definition;
    });
  } catch (error) {
    return info;
  }
  if (!operation) return info;

  const op: OperationDefinitionNode = operation;
  if (!info.operationName && op.name) info.operationName = op.name.value;
  op.selectionSet.selections.forEach((selection) => {
    if (selection.kind !== Kind.FIELD) return;
    info.rootFields.push(selection.alias ? selection.alias.value : selection.name.value);
  });
  return info;
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length > 0 ? raw[0] : null;
  return typeof raw === 'string' ? raw : null;
}

function firstErrorMessage(payload: unknown): string | null {
  const record = asRecord(payload);
  const errors = record.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = asRecord(errors[0]);
  return typeof first.message === 'string' ? first.message : 'Unknown error';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const rawBody = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
  const parsed = parseRequest(req, rawBody);
  const info = analyzeOperation(parsed.query, parsed.operationName);
  const auth = store.resolveToken(headerValue(req, 'x-api-key'));
  const tokenKind: TokenKind = auth.kind;

  // ---- Pre-execution failures (HTTP 500, no `data` key). PLAN.md §0.1. ----
  if (tokenKind === 'unknown' || tokenKind === 'revoked') {
    const message = tokenKind === 'unknown' ? INVALID_TOKEN_MESSAGE : REVOKED_TOKEN_MESSAGE;
    recordEvent({
      operationName: info.operationName,
      tokenKind,
      firmId: auth.firmId,
      variables: parsed.variables,
      ok: false,
      errorMessage: message,
    });
    sendJson(
      res,
      500,
      JSON.stringify({
        errors: [{ message, extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
      }),
    );
    return;
  }

  // ---- No x-api-key at all: HTTP 200, data null, access denied. ----
  if (tokenKind === 'none') {
    recordEvent({
      operationName: info.operationName,
      tokenKind,
      firmId: null,
      variables: parsed.variables,
      ok: false,
      errorMessage: ACCESS_DENIED_MESSAGE,
    });
    sendJson(
      res,
      200,
      JSON.stringify({
        errors: [
          {
            message: ACCESS_DENIED_MESSAGE,
            path: info.rootFields.length > 0 ? [info.rootFields[0]] : [],
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
        data: null,
      }),
    );
    return;
  }

  // ---- Execute. ----
  const search = (() => {
    const raw = req.url ?? '';
    const q = raw.indexOf('?');
    return q === -1 ? '' : raw.slice(q);
  })();

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (auth.token) headers['x-api-key'] = auth.token;

  const response = await yoga.fetch(`${store.MOCK_ORIGIN}${YOGA_ENDPOINT}${search}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : rawBody,
  });

  const text = await response.text();
  let payload: unknown = null;
  let parsedOk = false;
  try {
    payload = JSON.parse(text);
    parsedOk = true;
  } catch (error) {
    parsedOk = false;
  }

  const errorMessage = parsedOk ? firstErrorMessage(payload) : 'Malformed GraphQL response';
  recordEvent({
    operationName: info.operationName,
    tokenKind,
    firmId: auth.firmId,
    variables: parsed.variables,
    ok: errorMessage === null,
    errorMessage,
  });

  // Every executed operation answers HTTP 200, errors included (PLAN.md §0.1).
  // Anything yoga rejected before execution (bad JSON, bad method) keeps its
  // own status.
  const hasData =
    parsedOk && Object.prototype.hasOwnProperty.call(asRecord(payload), 'data');
  sendJson(res, hasData ? 200 : response.status, text);
}
