// PATCH /api/v1/participants/:id/barriers/:barrierId (endpoint E-16) — close a
// Barrier against the Salesforce Barriers object per FS v1.12 §F-06 / BR-36 /
// VR-13. Thin Next.js App Router shim: all logic lives in `@anthos/api`
// (`handleCloseBarrier`) so it stays unit-testable without a Next runtime.

import { handleCloseBarrier } from "@anthos/api";

// A mutation endpoint must never be statically cached; the wrapped middleware
// stack (withSession → withIdempotency) explicitly sets `Cache-Control:
// no-store` on every response.
export const dynamic = "force-dynamic";

// Next.js 15 App Router passes the dynamic-route params as a Promise on the
// second positional argument; `handleCloseBarrier` awaits it internally so
// the shim does not need to.
export function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; barrierId: string }> },
): Promise<Response> {
  return handleCloseBarrier(req, ctx);
}
