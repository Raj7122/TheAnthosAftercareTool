// GET /api/v1/participants/:id (endpoint E-08) — read the F-07 participant
// detail per FS v1.12 §F-07 / BR-38..BR-41 / VR-15. Thin Next.js App Router
// handler: all logic lives in `@anthos/api` (`handleGetParticipant`) so it
// stays unit-testable without a Next runtime.

import { handleGetParticipant } from "@anthos/api";

// A per-caller PII-bearing read; never statically cached. The handler also
// emits `Cache-Control: no-store` on every response (`responses.ts`).
export const dynamic = "force-dynamic";

// Next.js 15 App Router passes the dynamic-route params as a Promise on the
// second positional argument; `handleGetParticipant` awaits it internally so
// the shim does not need to.
export function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleGetParticipant(req, ctx);
}
