// GET /api/v1/auth/login (endpoint E-01) — entry point of the Salesforce OAuth
// Authorization Code + PKCE flow (F-01, TR-AUTH-1, SEC-AUTH-1). A thin Next.js
// App Router handler: all logic lives in `@anthos/api` (`handleAuthLogin`) so
// it stays unit-testable without a Next runtime. This is a PUBLIC endpoint —
// there is no session yet — so it is NOT wrapped by `withSession`.

import { handleAuthLogin } from "@anthos/api";

// Never statically cache the redirect — every request mints a fresh PKCE pair
// and `state`.
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleAuthLogin(req);
}
