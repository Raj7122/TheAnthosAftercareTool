// POST /api/v1/caseload/refresh (endpoint E-07) — the F-16 hard-refresh
// wholesale bulk SOQL replay. Thin Next.js App Router handler: all logic
// lives in `@anthos/api` (`handleRefreshCaseload`) so it stays unit-testable
// without a Next runtime.

import { handleRefreshCaseload } from "@anthos/api";

// A mutation endpoint must never be statically cached; the wrapped middleware
// stack (withSession → withIdempotency) explicitly sets `Cache-Control:
// no-store` on every response.
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleRefreshCaseload(req);
}
