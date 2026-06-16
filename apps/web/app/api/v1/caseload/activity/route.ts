// GET /api/v1/caseload/activity?from=&to= (endpoint E-46) — F-23 Phase B.
// Metadata-only dated activity (visits + comms + SMS) across the caller's owned
// participants, for the caseload activity calendar. Thin Next.js App Router
// shim: all logic lives in `@anthos/api` (`handleCaseloadActivity`) so it stays
// unit-testable without a Next runtime.

import { handleCaseloadActivity } from "@anthos/api";

// Never statically cache — per-specialist, PHI-adjacent, keyed off the
// `anthos_session` cookie and live Salesforce state.
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleCaseloadActivity(req);
}
