// Shared constants for the P1B-07 OAuth + iframe E2E. One source of truth so
// `playwright.config.ts` (which wires the BFF's env), the mock Salesforce
// server, the DB helper, and the spec cannot drift.
//
// Two ORIGINS, deliberately on different *sites*: the BFF on `localhost` and
// the mock-Salesforce parent on `127.0.0.1`. `localhost` and `127.0.0.1` are
// distinct registrable hosts, so the iframe is genuinely cross-site — exactly
// the condition under which `SameSite=None` is *required* for the session and
// OAuth cookies to ride (SEC-AUTH-4, SEC-THREAT-1). Same host on two ports
// would be same-site and would not exercise that boundary.

// The BFF (Next.js app under test) — `next start` on its default port.
export const BFF_PORT = 3000;
export const BFF_ORIGIN = `http://localhost:${BFF_PORT}`;

// The mock Salesforce server — serves the iframe parent page AND the OAuth
// authorize / token / SOQL endpoints. It stands in for the embedding
// Salesforce Console origin.
export const MOCK_SF_PORT = 4500;
export const MOCK_SF_ORIGIN = `http://127.0.0.1:${MOCK_SF_PORT}`;

// Connected App credentials — non-secret test values. The consumer secret
// travels only in the server-to-server BFF→mock-SF token POST; the E2E asserts
// it never appears in any browser-visible request (DoD: no client secret in a
// browser-visible payload, Immutable #3).
export const CLIENT_ID = "e2e-client-id";
export const CLIENT_SECRET = "e2e-client-secret";

// The callback URL the BFF registers as `redirect_uri`; the mock authorize
// endpoint 302s back here. MUST byte-match `SF_OAUTH_REDIRECT_URI`.
export const OAUTH_REDIRECT_PATH = "/api/v1/auth/callback";
export const OAUTH_REDIRECT_URI = `${BFF_ORIGIN}${OAUTH_REDIRECT_PATH}`;

// OAuth scope requested at /authorize and granted by the mock token endpoint —
// matches `DEFAULT_OAUTH_SCOPE` so BR-01's scope-coverage check passes.
export const OAUTH_SCOPE = "api refresh_token";

// Synthetic specialist identity — no real PII. The Salesforce User Id is a
// well-formed 18-char Id so `assertSalesforceId` accepts it; the rest are
// obviously-fake values on the reserved `.invalid` TLD.
export const SF_ORG_ID = "00D8K000000ABCDUA0";
export const SPECIALIST_ID = "0058K00000XYZAbQAO";
export const SF_IDENTITY_URL = `https://login.salesforce.com/id/${SF_ORG_ID}/${SPECIALIST_ID}`;
export const SPECIALIST_DISPLAY_NAME = "Test Specialist";
export const SPECIALIST_EMAIL = "test.specialist@example.invalid";
export const SPECIALIST_TIMEZONE = "America/New_York";

// The Salesforce PermissionSet API name the mock SOQL returns; the BFF maps it
// to the SPECIALIST role via `ANTHOS_ROLE_PERMISSION_SETS`. `/me` then reports
// `role: "specialist"` (the lowercase API §7.2.5 wire enum).
export const PERMISSION_SET_NAME = "Anthos_Aftercare_Specialist";
export const EXPECTED_WIRE_ROLE = "specialist";

// The test Postgres. CI injects `DEMO_POSTGRES_URL` (a service-container DB);
// local runs fall back to a matching local instance. `?sslmode=disable` is
// load-bearing — `packages/persistence/src/db/client.ts` keys SSL off it, and
// neither the CI service container nor a local dev Postgres terminates TLS.
export const POSTGRES_URL =
  process.env.DEMO_POSTGRES_URL ??
  "postgres://anthos:anthos@localhost:5432/anthos_e2e?sslmode=disable";
