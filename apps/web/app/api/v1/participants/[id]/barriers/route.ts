// POST /api/v1/participants/:id/barriers (endpoint E-15) — create a Barrier
// against the Salesforce Barriers object per FS v1.12 §F-06 / BR-33 / BR-35.
// Thin Next.js App Router handler: all logic lives in `@anthos/api`
// (`handleCreateBarrier`) so it stays unit-testable without a Next runtime.

import { handleCreateBarrier } from "@anthos/api";

// A mutation endpoint must never be statically cached; the wrapped middleware
// stack (withSession → withIdempotency) explicitly sets `Cache-Control:
// no-store` on every response.
export const dynamic = "force-dynamic";

// Next.js 15 App Router passes the dynamic-route params as a Promise on the
// second positional argument; `handleCreateBarrier` awaits it internally so
// the shim does not need to.
export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleCreateBarrier(req, ctx);
}
