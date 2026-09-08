/**
 * Mock Confido API server.
 *
 * Owns nothing but routing. The two mount points below are filled in by
 * separate modules and this file is not edited again:
 *
 *   ./graphql.ts   graphql-yoga over the real sandbox SDL   (PLAN.md §3.1/§3.3)
 *   ./control.ts   /__control/*, /app/*, /js/*, /iframe-target  (PLAN.md §3.4/§3.5)
 *
 * Routing:
 *   GET  /healthz                    → liveness, used by the Playwright webServer
 *   ANY  /v2, /graphql               → GraphQL
 *   POST /                           → GraphQL (the API is also mounted at the root)
 *   GET  /                           → plain index page
 *   everything else                  → control + fake app
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGraphQL, isGraphQLPath } from './graphql';
import { handleControl } from './control';
import { MOCK_PORT } from './store';

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const pathname = pathnameOf(req);

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ ok: true, service: 'confido-mock', pid: process.pid }));
      return;
    }

    if (isGraphQLPath(pathname) || (pathname === '/' && req.method === 'POST')) {
      await handleGraphQL(req, res);
      return;
    }

    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Confido mock</title>' +
          '<h1>Confido mock</h1><p>GraphQL at <code>/v2</code>. Control API at <code>/__control</code>.</p>',
      );
      return;
    }

    await handleControl(req, res);
  } catch (error) {
    // Never let the mock die mid-suite; surface the failure to the caller.
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error('[mock] unhandled error for', req.method, req.url, '\n', message);
    if (!res.headersSent) {
      res.writeHead(500, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
    }
    res.end(JSON.stringify({ error: 'mock server error', message }));
  }
});

server.listen(MOCK_PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${MOCK_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
