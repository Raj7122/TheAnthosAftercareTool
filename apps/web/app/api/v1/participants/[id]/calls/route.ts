// POST /api/v1/participants/:id/calls (endpoint E-10) — the F-08 Log-a-Call
// façade per API v1.3 §7.4.3. Writes a Salesforce Case Note with
// `Contact_Type='Phone'` implicit in the verb path. Thin Next.js App Router
// handler: all logic lives in `@anthos/api` (`handleLogCall`) so it stays
// unit-testable without a Next runtime.

import { handleLogCall } from "@anthos/api";

// A mutation endpoint must never be statically cached; the wrapped middleware
// stack (withSession → withIdempotency) explicitly sets `Cache-Control:
// no-store` on every response.
export const dynamic = "force-dynamic";

// Next.js 15 App Router passes the dynamic-route params as a Promise on the
// second positional argument; `handleLogCall` awaits it internally so the
// shim does not need to.
export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleLogCall(req, ctx);
}
