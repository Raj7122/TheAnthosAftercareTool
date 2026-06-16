// Canonical X-Trace-Id trace-context utility (API §8.5, ERD §17.1). A single
// trace_id correlates a request through idempotency_keys, audit_log, and every
// downstream persistence touch (ERD §8.2). This module is the ONE place the
// BFF resolves, forwards, and echoes the correlation id — the session and
// idempotency middleware consume it rather than carrying private copies.

import { randomUUID } from "node:crypto";

// audit_log.trace_id / idempotency_keys.trace_id are varchar(100) (ERD §6).
// An inbound value longer than this cannot be persisted, so it is discarded in
// favour of a generated id.
export const MAX_TRACE_ID_LENGTH = 100;

// A fresh correlation id. UUIDv4 per ERD §16 OSQ-18 — ULID was rejected so
// trace_id matches the format of the other primary keys.
export function generateTraceId(): string {
  return randomUUID();
}

// The request's correlation id: the inbound X-Trace-Id when present and within
// the varchar(100) bound, else a freshly generated UUIDv4 (API §8.5 — the
// client MAY send one; the server generates when absent). Inbound values are
// accepted leniently — the only hard constraint is the column width.
export function resolveTraceId(req: Request): string {
  const provided = req.headers.get("X-Trace-Id");
  if (
    provided !== null &&
    provided.length > 0 &&
    provided.length <= MAX_TRACE_ID_LENGTH
  ) {
    return provided;
  }
  return generateTraceId();
}

// Forward a request with X-Trace-Id set so a nested middleware/handler reads
// the SAME id. When the inbound header already equals the resolved id (the
// common case — the SPA sends it) the request passes through untouched, so no
// body transfer occurs.
export function forwardWithTraceId(req: Request, traceId: string): Request {
  if (req.headers.get("X-Trace-Id") === traceId) {
    return req;
  }
  const headers = new Headers(req.headers);
  headers.set("X-Trace-Id", traceId);
  return new Request(req, { headers });
}

// Echo X-Trace-Id on a response (API §8.5 — the server always echoes). The
// body stream is passed through untouched, so a streaming handler response
// stays streaming. Cache-Control is left to the caller.
export function echoTraceId(res: Response, traceId: string): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Trace-Id", traceId);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
