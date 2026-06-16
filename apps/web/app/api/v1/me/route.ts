// GET /api/v1/me (endpoint E-05) — returns the signed-in specialist's identity,
// role, session expiry, first-run state, and resolved feature flags; the SPA's
// single source of truth for the role gate (F-01, TR-AUTH-8, SEC-AUTHZ-1,
// ARC-13/22). A thin Next.js App Router handler: all logic lives in
// `@anthos/api` (`handleMe`) so it stays unit-testable without a Next runtime.

import { handleMe } from "@anthos/api";

// Never statically cache /me — the response carries the specialist's identity
// and live session state, keyed off the `anthos_session` cookie.
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleMe(req);
}
