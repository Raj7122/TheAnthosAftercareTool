// GET /api/v1/auth/callback (endpoint E-02) — the Salesforce OAuth redirect
// target that exchanges the authorization code for tokens and creates the
// opaque session (F-01, TR-AUTH-1/3/8/9, SEC-AUTH-1/2). A thin Next.js App
// Router handler: all logic lives in `@anthos/api` (`handleAuthCallback`) so it
// stays unit-testable without a Next runtime. This is a PUBLIC endpoint — there
// is no session yet — so it is NOT wrapped by `withSession`.

import { handleAuthCallback } from "@anthos/api";

// Never statically cache the callback — every request consumes a one-time
// authorization code and mints a fresh session.
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleAuthCallback(req);
}
