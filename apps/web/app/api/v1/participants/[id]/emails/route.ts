// POST /api/v1/participants/:id/emails (endpoint E-12) — the F-10 outbound-email
// façade per API v1.3. Invokes a tool-owned autolaunched Salesforce Flow which
// performs the send and creates the Activity record. Enforces own-caseload
// authz, email consent (Contact.HasOptedOutOfEmail), audit-before-response
// (Immutable #5), and idempotency (Immutable #6). Returns 503 EMAIL_NOT_CONFIGURED
// until the Flow is deployed and EMAIL_FLOW_API_NAME is set. Thin shim — all
// logic lives in `@anthos/api` (`handleSendEmail`).

import { handleSendEmail } from "@anthos/api";

export const dynamic = "force-dynamic";

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSendEmail(req, ctx);
}
