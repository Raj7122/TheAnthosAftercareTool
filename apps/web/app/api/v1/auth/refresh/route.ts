// POST /api/v1/auth/refresh (endpoint E-03) — the server side of the proactive
// OAuth token refresh: it exchanges the per-specialist Salesforce refresh token,
// rotates it, keeps the opaque session alive, and audits `auth.session_refresh`
// (F-01, TR-AUTH-3/4/6/9, SEC-AUTH-2/6, Immutable #3). A thin Next.js App
// Router handler: all logic lives in `@anthos/api` (`handleAuthRefresh`) so it
// stays unit-testable without a Next runtime. The session is read directly from
// the `anthos_session` cookie (a soft-expired session is accepted), so this is
// NOT wrapped by `withSession`.

import { handleAuthRefresh } from "@anthos/api";

// Never statically cache the refresh endpoint — every request rotates a
// credential and mutates session state.
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleAuthRefresh(req);
}
