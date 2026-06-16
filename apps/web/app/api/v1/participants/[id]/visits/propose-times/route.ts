// POST /api/v1/participants/:id/visits/propose-times (endpoint E-38) — propose
// candidate visit times. Read-shaped (no SF/Graph mutation); deterministic +
// quiet-hours-screened in Demo (MS Graph unavailable → fallbackUsed=true).
// Requires an Idempotency-Key per API §6.11. Thin shim — logic in `@anthos/api`.

import { handleProposeTimes } from "@anthos/api";

export const dynamic = "force-dynamic";

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleProposeTimes(req, ctx);
}
