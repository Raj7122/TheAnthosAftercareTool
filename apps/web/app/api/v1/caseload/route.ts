// GET /api/v1/caseload?queue=X (endpoint E-06) — the caller's engine-scored
// caseload, filtered to a queue (F-02 caseload, F-04 queues). A thin Next.js
// App Router handler: all logic lives in `@anthos/api` (`handleCaseload`) so
// it stays unit-testable without a Next runtime.

import { handleCaseload } from "@anthos/api";

// Never statically cache /caseload — the response is the caller's own
// caseload, keyed off the `anthos_session` cookie and live Salesforce state.
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleCaseload(req);
}
