// POST /api/v1/queue/sync (endpoint E-18) — force-flush the caller's pending
// offline queue items (F-14 Offline Tolerance, BR-68). A thin Next.js App
// Router handler: all logic lives in `@anthos/api` (`handleQueueSync`) so it
// stays unit-testable without a Next runtime.

import { handleQueueSync } from "@anthos/api";

// Never statically cache /queue/sync — every request is a mutation gated by
// session, rate-limit, and idempotency state.
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleQueueSync(req);
}
