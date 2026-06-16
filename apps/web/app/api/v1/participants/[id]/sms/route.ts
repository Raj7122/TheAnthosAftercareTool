// POST /api/v1/participants/:id/sms (endpoint E-11) — the F-09 outbound-SMS
// façade per API v1.3. Writes an outbound Mogli `Mogli_SMS__SMS__c` record;
// enforces participant-local quiet hours (Immutable #4), SMS consent (BR-46),
// audit-before-response (Immutable #5), and idempotency (Immutable #6). Thin
// Next.js App Router shim — all logic lives in `@anthos/api` (`handleSendSms`)
// so it stays unit-testable without a Next runtime.

import { handleSendSms } from "@anthos/api";

export const dynamic = "force-dynamic";

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSendSms(req, ctx);
}
