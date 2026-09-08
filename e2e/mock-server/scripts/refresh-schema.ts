/**
 * Opt-in, manual: re-introspect the live Confido sandbox and rewrite
 * `e2e/mock-server/schema.graphql`.
 *
 * The sandbox leaves introspection open, so this needs no credentials — but it
 * is the one thing in this repo that touches the network, so it refuses to run
 * unless CONFIDO_LIVE_INTROSPECT=1. The Playwright suite never invokes it; the
 * checked-in SDL is the source of truth.
 *
 *   CONFIDO_LIVE_INTROSPECT=1 npm --prefix e2e run refresh-schema
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClientSchema, getIntrospectionQuery, printSchema } from 'graphql';
import type { IntrospectionQuery } from 'graphql';

const ENDPOINT =
  process.env.CONFIDO_INTROSPECT_ENDPOINT ?? 'https://api.sandbox.gravity-legal.com/v2';

/** `__dirname` because the runtime is tsx in CommonJS mode. */
const SCHEMA_PATH = join(__dirname, '..', 'schema.graphql');

async function main(): Promise<void> {
  if (process.env.CONFIDO_LIVE_INTROSPECT !== '1') {
    console.error(
      'refresh-schema: refusing to run.\n' +
        'This is the only script in the harness that reaches the network.\n' +
        'Re-run with CONFIDO_LIVE_INTROSPECT=1 if you really mean to overwrite\n' +
        `${SCHEMA_PATH}`,
    );
    process.exit(1);
    return;
  }

  console.log(`refresh-schema: introspecting ${ENDPOINT}`);
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      operationName: 'IntrospectionQuery',
      query: getIntrospectionQuery({ descriptions: true }),
    }),
  });

  if (!response.ok) {
    throw new Error(`introspection failed: HTTP ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    data?: IntrospectionQuery;
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    const messages = payload.errors.map((e) => e.message ?? 'unknown').join('; ');
    throw new Error(`introspection returned errors: ${messages}`);
  }
  if (!payload.data) {
    throw new Error('introspection returned no data');
  }

  const sdl = printSchema(buildClientSchema(payload.data));
  writeFileSync(SCHEMA_PATH, `${sdl}\n`, 'utf8');
  console.log(
    `refresh-schema: wrote ${SCHEMA_PATH} (${sdl.split('\n').length} lines). ` +
      'Review the diff before committing — the mock resolvers are pinned to this SDL.',
  );
}

main().catch((error: unknown) => {
  console.error('refresh-schema failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
