// POST /api/v1/participants/:id/visits (endpoint E-13) — schedule a Stability
// Visit. Writes an IDW_Case_Note__c (Type='Stability Meeting', Status='Scheduled');
// Outlook invite degrades to null in Demo (no MS Graph creds). Enforces
// own-caseload authz, audit-before-response (Immutable #5), idempotency
// (Immutable #6). Thin shim — logic lives in `@anthos/api`.

import { handleScheduleVisit } from "@anthos/api";

export const dynamic = "force-dynamic";

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleScheduleVisit(req, ctx);
}
