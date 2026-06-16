// DELETE /api/v1/participants/:id/suppression (P1H-10 stub) — clear an
// active Path C SBOP suppression. All logic lives in `@anthos/api`
// (`handleUnSuppress`) so it stays unit-testable without a Next runtime.
//
// Pattern F discipline: today the data source for `pathCSuppression` does
// not exist (BR-21 / GAP-9 unratified), so the handler returns a
// deterministic 404 (`RESOURCE_NOT_FOUND` with `details.resource:
// "suppression"`). The middleware composition + route shim land now so the
// post-ratification ticket (P1H-10b) ships only the handler body change.

import { handleUnSuppress } from "@anthos/api";

// A mutation endpoint must never be statically cached; the wrapped middleware
// stack (withSession → withIdempotency) explicitly sets `Cache-Control:
// no-store` on every response.
export const dynamic = "force-dynamic";

// Next.js 15 App Router passes the dynamic-route params as a Promise on the
// second positional argument; `handleUnSuppress` awaits it internally so the
// shim does not need to.
export function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleUnSuppress(req, ctx);
}
