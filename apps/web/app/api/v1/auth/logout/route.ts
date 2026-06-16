// POST /api/v1/auth/logout (endpoint E-04) — terminates the opaque session:
// it soft-revokes the session server-side, wipes the stored Salesforce refresh
// token, audits `auth.session_end`, and clears the `anthos_session` cookie
// (F-01, TR-AUTH-9, SEC-AUTH-9, Immutable #5/#6). A thin Next.js App Router
// handler: all logic lives in `@anthos/api` (`handleAuthLogout`) so it stays
// unit-testable without a Next runtime. The session is read directly from the
// `anthos_session` cookie — an absent / revoked session is a graceful 204
// no-op — so this is NOT wrapped by `withSession`.

import { handleAuthLogout } from "@anthos/api";

// Never statically cache the logout endpoint — every request mutates session
// state.
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleAuthLogout(req);
}
