/**
 * Ring buffer of every GraphQL operation the mock received.
 *
 * Specs assert against this instead of sleeping: `expect.poll` over
 * GET /__control/events is the sanctioned way to wait for a server-side call.
 */

import type { EventsResponse, MockEvent, TokenKind } from './types';

const MAX_EVENTS = 2000;

const buffer: MockEvent[] = [];
let seq = 0;

export interface RecordEventInput {
  operationName: string | null;
  tokenKind: TokenKind;
  firmId: string | null;
  variables: Record<string, unknown>;
  ok: boolean;
  errorMessage?: string | null;
}

export function recordEvent(input: RecordEventInput): MockEvent {
  seq += 1;
  const event: MockEvent = {
    ts: Date.now(),
    seq,
    operationName: input.operationName,
    tokenKind: input.tokenKind,
    firmId: input.firmId,
    variables: input.variables,
    ok: input.ok,
    errorMessage: input.errorMessage ?? null,
  };
  buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  return event;
}

export interface QueryEventsOptions {
  /** Exclusive lower bound on `seq`. */
  since?: number;
  /** Exact operationName match. */
  op?: string;
  /** Only events for this firm. */
  firmId?: string;
}

export function queryEvents(options: QueryEventsOptions = {}): EventsResponse {
  const since = options.since ?? 0;
  const events = buffer.filter((e) => {
    if (e.seq <= since) return false;
    if (options.op && e.operationName !== options.op) return false;
    if (options.firmId && e.firmId !== options.firmId) return false;
    return true;
  });
  return { events, seq };
}

export function eventCount(): number {
  return buffer.length;
}

export function resetEvents(): void {
  buffer.length = 0;
}
