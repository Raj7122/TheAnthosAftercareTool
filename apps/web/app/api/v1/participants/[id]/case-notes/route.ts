// GET /api/v1/participants/:id/case-notes (endpoint E-09) — the F-07
// paginated case-note history per API §7.4.2 + §10.1. Thin Next.js App Router
// handler: all logic lives in `@anthos/api` (`handleGetCaseNotes`) so it stays
// unit-testable without a Next runtime.

import { handleCreateCaseNote, handleGetCaseNotes } from "@anthos/api";

// A per-caller PII-bearing read; never statically cached. The handler also
// emits `Cache-Control: no-store` on every response (`responses.ts`).
export const dynamic = "force-dynamic";

// Next.js 15 App Router passes the dynamic-route params as a Promise on the
// second positional argument; `handleGetCaseNotes` awaits it internally so the
// shim does not need to.
export function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleGetCaseNotes(req, ctx);
}

// POST /api/v1/participants/:id/case-notes — the general "Log Case Note" create
// (sibling to E-10 `…/calls`). Writes a real IDW_Case_Note__c row. NET-NEW
// endpoint shape (not in API v1.3); all logic in `@anthos/api`.
export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleCreateCaseNote(req, ctx);
}
