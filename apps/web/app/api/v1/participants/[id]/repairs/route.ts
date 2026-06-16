// POST /api/v1/participants/:id/repairs — create a Repair against the Salesforce
// Repair object. NET-NEW / off-spec (demo-driven): the authoritative specs cover
// only Barriers__c (F-06). Thin Next.js App Router handler — all logic lives in
// `@anthos/api` (`handleCreateRepair`) so it stays unit-testable without a Next
// runtime, mirroring the create-Barrier route shim.

import { handleCreateRepair } from "@anthos/api";

// A mutation endpoint must never be statically cached; the wrapped middleware
// stack (withSession → withIdempotency) sets `Cache-Control: no-store`.
export const dynamic = "force-dynamic";

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleCreateRepair(req, ctx);
}
