// POST /api/v1/participants/:id/visits/:visitId/log (P3A-03) — log a completed
// Stability Visit. Programmatic Case Note (→ Status='Completed') + Survey writes
// per the resolved GAP-8 path (NOT a Screen Flow REST invocation), then credits
// the nearest preceding checkpoint (BR-25). Enforces own-caseload authz,
// audit-before-response (Immutable #5), idempotency (Immutable #6).
//
// DELIBERATE DIVERGENCE from API v1.3 (which folds logging into E-13
// action='log') — the dedicated path was chosen per the P3A-03 ticket; see the
// handler header + PR body. Thin shim — logic lives in `@anthos/api`.

import { handleLogVisit } from "@anthos/api";

export const dynamic = "force-dynamic";

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; visitId: string }> },
): Promise<Response> {
  return handleLogVisit(req, ctx);
}
