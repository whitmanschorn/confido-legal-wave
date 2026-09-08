/**
 * PHASE 0 STUB — owned by unit C, replaced in Phase 1.
 * See PLAN.md §3.4 and §3.5.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export async function handleControl(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(404, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify({ error: 'not found' }));
}
