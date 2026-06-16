// P1B-07 — E2E: load the BFF in a mock Salesforce iframe, complete the OAuth +
// PKCE round-trip, retrieve `/me`. Closes F-01; covers the auth half of AC-01
// ("specialist lands on caseload from iframe load") — the test stops at `/me`
// returning 200, the precondition for the F-02 caseload load.
//
// Maps to: F-01; TR-AUTH-1..10; BR-01; AC-01; ARC-12/13/24; SEC-AUTH-1/4,
// SEC-THREAT-1; E-01/E-02/E-05. The whole P1B-01..P1B-06 chain runs in one
// real-browser flow against a mock Salesforce server (no live SF dependency).
//
// The two origins are on different *sites* (BFF on `localhost`, mock SF on
// `127.0.0.1`), so the iframe is genuinely cross-site — this is what makes
// `SameSite=None` load-bearing rather than incidentally satisfied.

import { expect, test } from "@playwright/test";

import {
  BFF_ORIGIN,
  CLIENT_SECRET,
  EXPECTED_WIRE_ROLE,
  MOCK_SF_ORIGIN,
  SPECIALIST_DISPLAY_NAME,
  SPECIALIST_EMAIL,
  SPECIALIST_ID,
  SPECIALIST_TIMEZONE,
} from "./_support/constants.js";
import { findAppFrame, waitForAppFrame } from "./_support/app-frame.js";
import { findSessionStartAuditRows, truncateAuthTables } from "./_support/db.js";

// The feature flags `/me` exposes in `features` (API §7.2.5; the four M-AI
// per-specialist flags — @anthos/api `ME_FEATURE_FLAG_KEYS`, ADR-08).
const M_AI_FLAG_KEYS = [
  "feature.m_ai.draft",
  "feature.m_ai.signal",
  "feature.m_ai.summary",
  "feature.m_ai.voice",
];

// Start each test attempt from an empty auth ledger so the audit assertion can
// demand EXACTLY one `auth.session_start` row. `beforeEach` (not `beforeAll`)
// is deliberate: it re-runs on a Playwright retry, where `beforeAll` would not
// — a retry against a non-truncated `audit_log` would see two rows and fail.
test.beforeEach(async () => {
  await truncateAuthTables();
});

test("completes the Salesforce OAuth + PKCE round-trip inside the iframe and reaches an authenticated session", async ({
  page,
  context,
}) => {
  // Every request the BROWSER issues. The server-to-server token exchange
  // (BFF → mock SF, carrying the client secret) is deliberately NOT in here —
  // that absence is asserted below (Immutable #3, DoD: no secret in a
  // browser-visible payload).
  const browserRequestUrls: string[] = [];
  page.on("request", (req) => browserRequestUrls.push(req.url()));

  // Set the response waiters up BEFORE navigating so neither can be missed.
  const callbackResponsePromise = page.waitForResponse(
    (res) => res.url().startsWith(`${BFF_ORIGIN}/api/v1/auth/callback`),
    { timeout: 30_000 },
  );
  const landingResponsePromise = page.waitForResponse(
    (res) =>
      res.url() === `${BFF_ORIGIN}/` && res.request().resourceType() === "document",
    { timeout: 30_000 },
  );

  // Load the mock Salesforce Console page; its <iframe src=.../auth/login>
  // drives the chain login → authorize → callback → /.
  await page.goto(`${MOCK_SF_ORIGIN}/`);

  const callbackResponse = await callbackResponsePromise;
  // Wall-clock instant the browser observed the callback 302 — the upper
  // bound for the audit-before-response assertion.
  const callbackObservedAt = Date.now();
  const landingResponse = await landingResponsePromise;

  // --- the OAuth round-trip succeeded (E-02) ---
  // A failed exchange would 302 to `/?authError=...`; success lands on `/`.
  expect(callbackResponse.status()).toBe(302);
  expect(callbackResponse.headers()["location"]).toBe("/");

  // The iframe lands on `/`; on the laptop variant it then client-redirects
  // to `/caseload`. Either is a settled, authenticated app frame — what this
  // test needs is a same-origin BFF frame to evaluate `/me` from, not a
  // specific path. (The CSP/landing assertions above pin the `/` document.)
  await waitForAppFrame(page, 10_000);
  const appFrame = findAppFrame(page);
  if (appFrame === undefined) {
    throw new Error("the iframe never settled on the BFF app");
  }

  // --- PKCE S256 was used on the authorize request (Immutable #3, BR-01) ---
  const authorizeUrl = browserRequestUrls.find((u) =>
    u.startsWith(`${MOCK_SF_ORIGIN}/services/oauth2/authorize`),
  );
  expect(authorizeUrl, "the iframe should have hit the mock SF authorize endpoint").toBeDefined();
  expect(authorizeUrl).toContain("code_challenge_method=S256");
  expect(authorizeUrl).toContain("code_challenge=");

  // --- no client secret reached the browser (Immutable #3) ---
  // The token POST is server-to-server, so it never appears as a browser
  // request — and the secret appears in no browser-visible URL.
  expect(browserRequestUrls.some((u) => u.includes(CLIENT_SECRET))).toBe(false);
  expect(browserRequestUrls.some((u) => u.includes("/services/oauth2/token"))).toBe(false);

  // --- the session cookie has the iframe-safe attributes (SEC-AUTH-4) ---
  const cookies = await context.cookies(BFF_ORIGIN);
  const sessionCookie = cookies.find((c) => c.name === "anthos_session");
  expect(sessionCookie, "an anthos_session cookie should be set").toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.secure).toBe(true);
  expect(sessionCookie?.sameSite).toBe("None");

  // --- the SPA is framed under a production-shaped allowlist (TR-AUTH-5) ---
  const csp = landingResponse.headers()["content-security-policy"];
  expect(csp).toContain("frame-ancestors");
  expect(csp).toContain(MOCK_SF_ORIGIN);
  expect(csp).not.toContain("*");

  // --- GET /api/v1/me from inside the iframe context (E-05, API §7.2.5) ---
  const meResult = await appFrame.evaluate(async () => {
    const res = await fetch("/api/v1/me", { credentials: "include" });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, traceId: res.headers.get("x-trace-id"), body };
  });
  expect(meResult.status).toBe(200);
  expect(meResult.traceId, "/me should echo a trace id").toBeTruthy();

  const me = meResult.body;
  expect(me.specialistId).toBe(SPECIALIST_ID);
  expect(me.displayName).toBe(SPECIALIST_DISPLAY_NAME);
  expect(me.email).toBe(SPECIALIST_EMAIL);
  expect(me.timezone).toBe(SPECIALIST_TIMEZONE);
  // `role` is the lowercase wire enum, resolved from the seeded permission set.
  expect(me.role).toBe(EXPECTED_WIRE_ROLE);
  expect(typeof me.permissionsHash).toBe("string");
  expect(typeof me.firstRunCompleted).toBe("boolean");
  expect(typeof me.sessionExpiresAt).toBe("string");
  expect(Number.isNaN(Date.parse(me.sessionExpiresAt as string))).toBe(false);
  // `features` — exactly the four M-AI flags, each a boolean.
  const features = me.features as Record<string, unknown>;
  expect(Object.keys(features).sort()).toEqual([...M_AI_FLAG_KEYS]);
  for (const value of Object.values(features)) {
    expect(typeof value).toBe("boolean");
  }

  // --- the audit row was durable BEFORE the callback 302 (Immutable #5) ---
  // `startSession` awaits `writeAuditEntry` before the callback builds its
  // 302, so the DB-stamped `timestamp` necessarily precedes the instant the
  // browser observed the response (same host clock for DB + runner).
  const auditRows = await findSessionStartAuditRows(SPECIALIST_ID);
  expect(auditRows).toHaveLength(1);
  const auditRow = auditRows[0];
  if (auditRow === undefined) {
    throw new Error("expected exactly one auth.session_start audit row");
  }
  expect(auditRow.outcome).toBe("SUCCESS");
  expect(auditRow.timestamp.getTime()).toBeLessThanOrEqual(callbackObservedAt);
});

test("rejects a state-changing request from a non-allowlisted Origin with 403 CSRF_ORIGIN_MISMATCH", async ({
  request,
}) => {
  // Cross-checks P1B-06: `enforceOrigin` is the first gate on a mutation
  // endpoint, so a non-allowlisted Origin is rejected before any refresh
  // logic runs (API §8.6, SEC-THREAT-1). Playwright's `request` API can set
  // the otherwise-forbidden `Origin` header and read the 403 body.
  //
  // This request also carries no `anthos_session` cookie — were the Origin
  // allowlisted, the endpoint would 401 AUTH_SESSION_INVALID. The 403 here is
  // therefore proof the Origin gate fires *before* session validation.
  const response = await request.post(`${BFF_ORIGIN}/api/v1/auth/refresh`, {
    headers: {
      Origin: "https://evil.example.com",
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
    },
    failOnStatusCode: false,
  });

  expect(response.status()).toBe(403);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.code).toBe("CSRF_ORIGIN_MISMATCH");
});
