// P1F-06 — Opt-in live-SF variant of the F-08 Log-a-Call tap-to-submit perf
// test. Drives the same iteration loop the mock-SF `log-call-perf.e2e.ts`
// drives, but against the anthoshome3--pursuit sandbox so the median
// includes real SF authz + recompute round-trips. Satisfies the DoD line
// "test writes go to sandbox SF, not a mock" — see PR body for the
// substrate-split rationale.
//
// Maps to: F-08; TR-WRITE-4, NFR-PERF-3; AC-30; E-10; Immutable #1.
//
// Status: SCAFFOLD. The test is `describe.skip`'d until BOTH conditions hold:
//   1. `ANTHOS_E2E_LIVE_SF=1` is set in the test environment.
//   2. P1F-03b has shipped — until then, E-10's `caseNoteWrite` returns the
//      schema-gap stub (no SF Case Note is actually written), which means a
//      live run today would measure the loop with the stub still in the
//      middle. That is informative for production-budget sanity but does
//      not yet exercise the spec'd end-to-end SF write that AC-30's
//      "submit confirmation visible" implicitly covers.
//
// When both conditions hold, flipping the skip + wiring the live-SF env
// (SF_LOGIN_URL pointed at anthoshome3--pursuit, Connected App creds, real
// OAuth round-trip via Playwright driving the SF login form) reuses the
// existing `runOneIteration` / `readStagesFromPage` / `computeMedian`
// helpers without change. The asserted budget stays at 30s — the spec
// number, not a substrate-specific one.

import { test } from "@playwright/test";

// When the post-P1F-03b implementor unskips this block, re-import the
// helpers below from `./_support/log-call-fixtures.js`:
//   computeMedian, computeStageMedians, readStagesFromPage, runOneIteration,
//   type LogCallPerfSample
// They're already exported and unit-tested via the mock-SF asserted
// `log-call-perf.e2e.ts`; no helper changes should be needed.

const LIVE_ENABLED = process.env.ANTHOS_E2E_LIVE_SF === "1";

test.describe.skip("F-08 tap-to-submit ≤30s — live SF sandbox (BLOCKED on P1F-03b)", () => {
  test("median ≤30s against anthoshome3--pursuit", async ({ page: _page }) => {
    if (!LIVE_ENABLED) {
      // Defensive — the outer skip should keep us out. Repeated here so a
      // future `.only` doesn't accidentally fire the live path in CI.
      test.skip(true, "ANTHOS_E2E_LIVE_SF=1 not set");
    }
    // TODO(post-P1F-03b):
    //   1. Authenticate via the real OAuth 2.0 + PKCE flow (Immutable #3 —
    //      no password flows). Point the BFF's SF_LOGIN_URL at the
    //      anthoshome3--pursuit sandbox, then drive the SF interactive
    //      login form via Playwright as a one-shot to complete the
    //      authorization code redemption — the BFF's PKCE handshake
    //      remains unchanged. Reuse the same session-cookie surface the
    //      SPA expects so the iteration helpers work unchanged.
    //   2. Skip `installSfFixture` / `seedCaseloadCache` — the live SF
    //      sandbox provides its own caseload data (anonymized per the
    //      project's `project_sandbox_curated` memory).
    //   3. Pick ≥20 distinct participantIds from the live caseload (read
    //      via the /api/v1/caseload BFF endpoint) and run the loop:
    //
    //        const samples: LogCallPerfSample[] = [];
    //        for (const id of participantIds.slice(0, 20)) {
    //          const wallMs = await runOneIteration(_page, id);
    //          const stages = await readStagesFromPage(_page);
    //          samples.push({ iteration: …, participantId: id, wallMs, stages });
    //        }
    //        const median = computeMedian(samples.map(s => s.wallMs));
    //        expect(median).toBeLessThanOrEqual(30_000);
    //
    //   4. Rotate the test specialist account if iteration writes pollute
    //      the live sandbox audit log past the run's retention window.
    //
    // Until then: this block stays skipped. The asserted median in CI is
    // the mock-SF `log-call-perf.e2e.ts`.
    throw new Error("live-SF perf variant is a scaffold — implement post-P1F-03b");
  });
});
