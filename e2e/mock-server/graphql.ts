/**
 * PHASE 0 STUB — owned by unit G, replaced in Phase 1.
 * See PLAN.md §3.1 and §3.3.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export function isGraphQLPath(pathname: string): boolean {
  return pathname === '/v2' || pathname === '/graphql';
}

export async function handleGraphQL(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(501, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ errors: [{ message: 'GraphQL mock not implemented yet' }] }));
}
