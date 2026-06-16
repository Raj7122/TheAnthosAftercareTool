// Mock Salesforce server for the P1B-07 OAuth + iframe E2E. Stands in for the
// embedding Salesforce Console: it serves the iframe parent page AND the
// OAuth surface the BFF talks to (authorize, token, SOQL query). Run as a
// standalone process by Playwright's `webServer` (via `tsx`) — no live network
// dependency on the real Salesforce sandbox, so the E2E is deterministic in CI.
//
// Scope discipline (ticket note: do NOT hand-roll a full SF OAuth surface):
// only the fields the auth flow actually reads are implemented —
//   • /services/oauth2/authorize — validates `state` + `code_challenge` shape
//     and `code_challenge_method=S256`, then issues a synthetic `code`;
//   • /services/oauth2/token     — validates the PKCE `code_verifier` against
//     the original `code_challenge` (RFC 7636 S256) before issuing tokens;
//   • /services/data/*/query     — answers the two SOQL reads the callback
//     makes (PermissionSetAssignment for the role, User for the identity).
//
// All data is synthetic — no PII (see `constants.ts`).

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MOCK_SF_ORIGIN,
  MOCK_SF_PORT,
  PERMISSION_SET_NAME,
  SF_IDENTITY_URL,
  SPECIALIST_DISPLAY_NAME,
  SPECIALIST_EMAIL,
  SPECIALIST_TIMEZONE,
} from "./constants.js";

// The iframe parent page, served from the mock-SF origin so that origin is the
// one the BFF's `frame-ancestors` allowlist must name.
const PARENT_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "salesforce-parent.html"),
  "utf8",
);

// Issued authorization codes → the `code_challenge` they were minted against.
// One-time use: the entry is deleted on a successful token exchange.
const issuedCodes = new Map<string, { codeChallenge: string }>();

// RFC 7636 §4.6 — the S256 transform the BFF's PKCE pair was built with.
function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// GET /services/oauth2/authorize — the IdP authorize step. Validates the
// request shape the BFF (P1B-01) produced, then 302-redirects to the BFF
// callback with a synthetic `code` and the echoed `state`.
function handleAuthorize(url: URL, res: ServerResponse): void {
  const params = url.searchParams;
  const responseType = params.get("response_type");
  const codeChallenge = params.get("code_challenge");
  const challengeMethod = params.get("code_challenge_method");
  const state = params.get("state");
  const redirectUri = params.get("redirect_uri");

  const valid =
    responseType === "code" &&
    challengeMethod === "S256" &&
    codeChallenge !== null &&
    codeChallenge.length >= 43 &&
    codeChallenge.length <= 128 &&
    state !== null &&
    state.length > 0 &&
    params.get("client_id") !== null &&
    redirectUri !== null;

  if (!valid) {
    sendJson(res, 400, { error: "invalid_request" });
    return;
  }

  const code = randomBytes(24).toString("hex");
  issuedCodes.set(code, { codeChallenge: codeChallenge as string });

  const location = new URL(redirectUri as string);
  location.searchParams.set("code", code);
  location.searchParams.set("state", state as string);
  res.writeHead(302, { Location: location.toString(), "Cache-Control": "no-store" });
  res.end();
}

// The static refresh token the BFF env wires in for the P1C-07 caseload
// perf test (no auth-code round-trip is needed before the cold-path read).
// Test-only material — kept in sync between mock-salesforce.ts and the
// playwright.config.ts `bffEnv` block.
const BOOTSTRAP_REFRESH_TOKEN = "e2e-bootstrap-refresh-token";

// POST /services/oauth2/token — handles BOTH OAuth grants the BFF uses:
//   - `authorization_code` — the P1B login round-trip; verifies the PKCE
//     `code_verifier` against the stored `code_challenge` (S256).
//   - `refresh_token` — the P0-12a `SalesforceConnectedAppAuth` path used by
//     the deployed BFF for server-to-server reads (caseload hydration). The
//     stored mock refresh token from a prior auth-code exchange is accepted;
//     so is the static `e2e-bootstrap-refresh-token` that the P1C-07 BFF env
//     wires in (no auth-code round-trip needed before the caseload test).
//
// Returns only the fields `exchangeAuthorizationCode` and
// `SalesforceConnectedAppAuth.resolve()` read.
async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = new URLSearchParams(await readBody(req));
  const grantType = form.get("grant_type");

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    // Accept either the mock token previously issued by the auth-code arm or
    // the bootstrap token the BFF env wires in for the caseload perf test.
    if (refreshToken !== "mock-refresh-token" && refreshToken !== BOOTSTRAP_REFRESH_TOKEN) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    sendJson(res, 200, {
      access_token: "00D!mock-access-token",
      instance_url: MOCK_SF_ORIGIN,
      id: SF_IDENTITY_URL,
      scope: "api refresh_token",
      token_type: "Bearer",
      issued_at: String(Date.now()),
      expires_in: 7200,
    });
    return;
  }

  const code = form.get("code") ?? "";
  const codeVerifier = form.get("code_verifier") ?? "";
  const issued = issuedCodes.get(code);
  // invalid_grant covers a replayed/unknown code or a PKCE-verifier mismatch.
  if (
    grantType !== "authorization_code" ||
    issued === undefined ||
    codeVerifier.length === 0 ||
    s256(codeVerifier) !== issued.codeChallenge
  ) {
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }
  issuedCodes.delete(code); // one-time use

  sendJson(res, 200, {
    access_token: "00D!mock-access-token",
    refresh_token: "mock-refresh-token",
    instance_url: MOCK_SF_ORIGIN,
    id: SF_IDENTITY_URL,
    scope: "api refresh_token",
    token_type: "Bearer",
    issued_at: String(Date.now()),
    expires_in: 7200,
  });
}

// In-memory fixture for the caseload bulk-hydration SOQL (P1C-07). The
// test installs records via POST /test/install-fixture before each cold
// pass; the SOQL handler discriminates on the `FROM <object>` substring.
// State persists across requests inside this single mock-sf process and is
// reset by either an explicit install or a DELETE.
interface CaseloadSoqlFixture {
  enrollments: ReadonlyArray<Record<string, unknown>>;
  barriers: ReadonlyArray<Record<string, unknown>>;
  incidents: ReadonlyArray<Record<string, unknown>>;
  arrears: ReadonlyArray<Record<string, unknown>>;
  repairs: ReadonlyArray<Record<string, unknown>>;
}

let caseloadFixture: CaseloadSoqlFixture = {
  enrollments: [],
  barriers: [],
  incidents: [],
  arrears: [],
  repairs: [],
};

// Records currently installed — exposed for the `GET /test/install-fixture`
// debug read.
function snapshotFixture(): CaseloadSoqlFixture {
  return caseloadFixture;
}

function setFixture(next: CaseloadSoqlFixture): void {
  caseloadFixture = next;
}

// Routes a single SOQL string to a records array. Matched substrings are
// `FROM <object>` because `bulk-hydration.ts` always selects FROM a single
// canonical object name; PermissionSetAssignment and User remain the
// auth-side reads. An unmatched SOQL string returns `records: []` — same
// behaviour as the original handler so unrelated reads don't 500.
function recordsForSoql(soql: string): ReadonlyArray<unknown> {
  if (soql.includes("PermissionSetAssignment")) {
    return [{ PermissionSet: { Name: PERMISSION_SET_NAME } }];
  }
  if (soql.includes("FROM User")) {
    return [
      {
        Name: SPECIALIST_DISPLAY_NAME,
        Email: SPECIALIST_EMAIL,
        TimeZoneSidKey: SPECIALIST_TIMEZONE,
      },
    ];
  }
  if (soql.includes("FROM IDW_Program_Enrollment__c")) {
    return caseloadFixture.enrollments;
  }
  if (soql.includes("FROM Barriers__c")) {
    return caseloadFixture.barriers;
  }
  if (soql.includes("FROM Incident_Participant__c")) {
    return caseloadFixture.incidents;
  }
  if (soql.includes("FROM Arrear__c")) {
    return caseloadFixture.arrears;
  }
  if (soql.includes("FROM Repair__c")) {
    return caseloadFixture.repairs;
  }
  // The create-Repair handler resolves the participant's Unit Engagement
  // (the two-hop `Repair__c.Unit_Rental__c` link) before writing. Every e2e
  // fixture participant has a synthetic Unit Engagement so the happy path
  // writes; the no-Unit-Engagement 409 fallback is exercised at the unit layer.
  if (soql.includes("FROM Unit_Rental__c")) {
    return [{ Id: "a1kE2E0UNITRENTAL" }];
  }
  return [];
}

// GET /services/data/<v>/query?q=<soql> — single-SOQL read endpoint
// (round-trip 1 in bulk hydration, plus the two auth-side reads).
function handleQuery(url: URL, res: ServerResponse): void {
  const soql = url.searchParams.get("q") ?? "";
  const records = recordsForSoql(soql);
  sendJson(res, 200, { totalSize: records.length, done: true, records });
}

// POST /services/data/<v>/sobjects/<sobjectType>/ — DML create endpoint used
// by `rest-client.ts:createRecord`. The P1F-03b case-note write seam hits
// this; pre-flip the seam short-circuited and never reached SF, so the
// mock didn't need a DML handler. We accept any sobject identifier (the
// real client validates the shape upstream), synthesize a 15-char SF-shaped
// id, and return the canonical `{ id, success: true, errors: [] }` body
// the rest-client expects. No DML validation — handlers that need to
// exercise SF_VALIDATION_FAILED inject a SalesforceError at the unit-test
// layer; E2E is the happy-path substrate.
async function handleCreateRecord(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    // Drain the body so the client doesn't see a hung socket. We don't read
    // it — the perf test only asserts the response shape + dialog close.
    await readBody(req);
  } catch {
    sendJson(res, 400, { error: "invalid_request" });
    return;
  }
  // Synthesize a 15-char SF id keyed on a 6-char random suffix. The
  // `a1d` prefix is the IDW_Case_Note__c key prefix in the live sandbox;
  // for any other sobject the prefix is informational only — handlers
  // only assert id shape (15/18 chars `[A-Za-z0-9]+`).
  const sobjectType = url.pathname.split("/").filter(Boolean).pop() ?? "X";
  const prefix = sobjectType.startsWith("IDW_Case_Note") ? "a1dE2E" : "a0KE2E";
  const id = `${prefix}${randomBytes(5).toString("hex").slice(0, 9).toUpperCase()}`;
  sendJson(res, 201, { id, success: true, errors: [] });
}

// POST /services/data/<v>/composite/batch — composite-batch endpoint used by
// `bulk-hydration.ts` round-trip 2 (one HTTP call carrying up to 4 SOQL
// sub-queries: Barriers + Incident_Participant + Arrear + Repair). Each
// sub-request is `{ method: GET, url: "v67.0/query?q=<soql>" }`; the response
// is `{ hasErrors, results: [{ statusCode, result: { totalSize, done,
// records } }] }`. See `rest-client.ts:compositeBatch`.
async function handleCompositeBatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { batchRequests?: ReadonlyArray<{ method?: string; url?: string }> };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  const requests = body.batchRequests ?? [];
  const results = requests.map((sub) => {
    // Sub-URL shape is `v67.0/query?q=<encoded soql>`; parse the q parameter
    // out by treating it as a relative URL against the mock origin.
    const subUrl = new URL(sub.url ?? "", MOCK_SF_ORIGIN);
    const soql = subUrl.searchParams.get("q") ?? "";
    const records = recordsForSoql(soql);
    return {
      statusCode: 200,
      result: { totalSize: records.length, done: true, records },
    };
  });
  sendJson(res, 200, { hasErrors: false, results });
}

// POST /test/install-fixture — the perf E2E pushes its synthetic 75-
// participant records here before each cold-path test. The body shape
// mirrors `CaseloadSoqlFixture`; arrays default to `[]` so a partial install
// (e.g. only enrollments) is supported.
async function handleInstallFixture(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Partial<CaseloadSoqlFixture>;
  try {
    body = JSON.parse(await readBody(req)) as Partial<CaseloadSoqlFixture>;
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }
  setFixture({
    enrollments: body.enrollments ?? [],
    barriers: body.barriers ?? [],
    incidents: body.incidents ?? [],
    arrears: body.arrears ?? [],
    repairs: body.repairs ?? [],
  });
  sendJson(res, 200, { installed: true, counts: countsOf(snapshotFixture()) });
}

function handleGetFixture(res: ServerResponse): void {
  sendJson(res, 200, { fixture: snapshotFixture(), counts: countsOf(snapshotFixture()) });
}

function countsOf(f: CaseloadSoqlFixture): Record<string, number> {
  return {
    enrollments: f.enrollments.length,
    barriers: f.barriers.length,
    incidents: f.incidents.length,
    arrears: f.arrears.length,
    repairs: f.repairs.length,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", MOCK_SF_ORIGIN);
  const method = req.method ?? "GET";
  // Path only — never the query string, which carries the synthetic `code`.
  console.log(`[mock-sf] ${method} ${url.pathname}`);

  if (method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PARENT_HTML);
    return;
  }
  if (method === "GET" && url.pathname === "/services/oauth2/authorize") {
    handleAuthorize(url, res);
    return;
  }
  if (method === "POST" && url.pathname === "/services/oauth2/token") {
    void handleToken(req, res);
    return;
  }
  if (method === "GET" && url.pathname.endsWith("/query")) {
    handleQuery(url, res);
    return;
  }
  if (method === "POST" && url.pathname.endsWith("/composite/batch")) {
    void handleCompositeBatch(req, res);
    return;
  }
  // DML create: `/services/data/<v>/sobjects/<sobjectType>/`. The trailing
  // slash is canonical per the real SF API and is enforced by the rest-
  // client URL builder.
  if (
    method === "POST" &&
    url.pathname.includes("/services/data/") &&
    url.pathname.includes("/sobjects/")
  ) {
    void handleCreateRecord(url, req, res);
    return;
  }
  if (method === "POST" && url.pathname === "/test/install-fixture") {
    void handleInstallFixture(req, res);
    return;
  }
  if (method === "GET" && url.pathname === "/test/install-fixture") {
    handleGetFixture(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(MOCK_SF_PORT, "127.0.0.1", () => {
  console.log(`[mock-sf] listening on ${MOCK_SF_ORIGIN}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
