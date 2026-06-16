// POST /api/v1/queue/:id/resolve (endpoint E-19) — specialist's disposition of
// a Review Required offline-queue item (F-14, Pattern E, TR-OFFLINE-5a). A
// thin Next.js App Router shim: all logic lives in `@anthos/api`
// (`handleQueueResolve`) so it stays unit-testable without a Next runtime.
//
// SPEC NUMBERING — the ticket title + impl-plan §3 row 463 both label this
// endpoint E-20, but API_v1_3.md §7.5 row 372 + §7.5.3 carry it as E-19
// (E-20 is `GET /supervisor/dashboard`). Spec precedence ranks the
// API doc above the impl plan, so this file uses E-19 throughout. See the
// matching note in `packages/api/src/queue/post-queue-resolve.ts`.

import { handleQueueResolve } from "@anthos/api";

// Never statically cache this endpoint — every request is a mutation gated by
// session + idempotency state.
export const dynamic = "force-dynamic";

// Next.js 15 App Router passes the dynamic-route params as a Promise on the
// second positional argument; `handleQueueResolve` awaits it internally so
// the shim does not need to.
export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleQueueResolve(req, ctx);
}
