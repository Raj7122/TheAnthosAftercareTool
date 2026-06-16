// GET /api/v1/queue/pending (endpoint E-17) — the caller's pending offline
// queue items (F-14 Offline Tolerance). A thin Next.js App Router handler:
// all logic lives in `@anthos/api` (`handleQueuePending`) so it stays
// unit-testable without a Next runtime.

import { handleQueuePending } from "@anthos/api";

// Never statically cache /queue/pending — the response is the caller's own
// queue, keyed off the `anthos_session` cookie and live DB state.
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleQueuePending(req);
}
