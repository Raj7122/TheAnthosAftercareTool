// P1F-06 — E2E perf test: F-08 Log-a-Call tap-to-submit median ≤30s.
//
// Closes the sub-phase 1F exit gate. Composes P1F-04 (action sheet UI) +
// P1F-05 (Pattern A optimistic reconciliation) against the same mock-SF +
// real-Postgres substrate the P1C-07 caseload perf test uses, and asserts
// AC-30 / NFR-PERF-3 / TR-WRITE-4 holds for the user-perceived loop end-
// to-end across ≥20 iterations.
//
// Maps to: F-08; TR-WRITE-4, NFR-PERF-3; AC-30; E-10; Pattern A.
//
// Surface caveat: AC-30 names the F-07 detail page, but F-07 (P1F-08) has
// not shipped. The action sheet today launches from the caseload row's
// overflow menu (CaseloadView.handleOpenLogCall) — the same sheet F-07
// will mount later. When P1F-08 lands the test will be re-pointed at the
// detail-page launcher with no change to the asserted loop. See PR body.
//
// Substrate caveat: post-P1F-03b, E-10's `caseNoteWrite` seam calls a real
// `restClient.createRecord('IDW_Case_Note__c', ...)`. The mock-SF DML
// handler (`mock-salesforce.ts:handleCreateRecord`) answers with the
// canonical `{ id, success: true, errors: [] }` shape, so this test
// measures the full real-write code path against a deterministic substrate.
// The DoD line about writing to live sandbox SF is satisfied by the opt-in
// `log-call-perf.live.e2e.ts` variant. See PR body.
//
// Per-sample stage breakdown is captured via `performance.mark` entries set
// in the SPA (sheet:open, submit:start, optimistic:applied, network:start,
// network:end, reconciled, sheet:closed). The wall-clock median is the
// load-bearing assertion; the per-stage medians are logged so a future
// regression points the diagnosis at the offending stage.

import { expect, test } from "@playwright/test";

import {
  buildSoqlFixture,
  buildWarmCaseloadBodies,
  generateSyntheticCaseload,
  installSfFixture,
} from "./_support/caseload-fixtures.js";
import {
  seedCaseloadCache,
  truncateCaseloadTables,
} from "./_support/caseload-db.js";
import { BFF_ORIGIN, MOCK_SF_ORIGIN } from "./_support/constants.js";
import { waitForAppFrame } from "./_support/app-frame.js";
import {
  computeMedian,
  computeStageMedians,
  readStagesFromPage,
  runOneIteration,
  type LogCallPerfSample,
} from "./_support/log-call-fixtures.js";

// AC-30 / NFR-PERF-3 / TR-WRITE-4: median tap-to-submit ≤30s. The budget is
// generous because Pattern A's optimistic update closes the user-perceived
// loop in milliseconds — the 30s envelope is the SF round-trip + reconcile
// worst case. On the mock-SF substrate we expect the actual median to land
// in the hundreds of milliseconds; a median near 30s would itself be a
// signal that the optimistic loop is broken.
const MEDIAN_BUDGET_MS = 30_000;

// Spec floor — AC-30 requires ≥20 iterations. The test stays at the floor
// to keep CI wall-clock bounded (~20 iterations × ~500ms ≈ 10s of measured
// work, plus Playwright frame overhead). The fixture supplies 75 distinct
// participants so the loop never reuses one.
const ITERATIONS = 20;

async function authenticateInIframe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto(`${MOCK_SF_ORIGIN}/`);
  await waitForAppFrame(page);
}

test.beforeEach(async () => {
  await truncateCaseloadTables();
});

test("F-08 tap-to-submit median ≤30s across ≥20 iterations (AC-30, NFR-PERF-3, TR-WRITE-4)", async ({
  page,
}) => {
  const fixture = generateSyntheticCaseload();
  // Both warm cache + cold SOQL: warm so the initial /caseload render is
  // instant (it is not what AC-30 measures); cold-path SOQL so the
  // per-iteration `scoreCaseload` recompute inside E-10 returns real
  // enrollment rows (the priority-recompute step hydrates from the same
  // fixture). Authz lookup also reads `IDW_Program_Enrollment__c`, and the
  // mock SF returns the installed enrollments for any WHERE-Id query;
  // every fixture row is owned by SPECIALIST_ID so the authz gate passes
  // regardless of which participant the test iterates over.
  await installSfFixture(buildSoqlFixture(fixture));
  await seedCaseloadCache(buildWarmCaseloadBodies(fixture));
  await authenticateInIframe(page);
  await page.goto(`${BFF_ORIGIN}/caseload`);
  await expect(page.locator('[data-testid="caseload-row"]')).toHaveCount(75);

  const samples: LogCallPerfSample[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const participant = fixture.participants[i];
    if (participant === undefined) {
      throw new Error(`fixture has no participant at index ${i}`);
    }
    const wallMs = await runOneIteration(page, participant.enrollmentId);
    const stages = await readStagesFromPage(page);
    samples.push({
      iteration: i,
      participantId: participant.enrollmentId,
      wallMs,
      stages,
    });
  }

  const wallMedian = computeMedian(samples.map((s) => s.wallMs));
  const stageMedians = computeStageMedians(samples);
  const wallSamples = samples.map((s) => s.wallMs);

  console.log(
    `[P1F-06] tap-to-submit wall-clock median: ${wallMedian.toFixed(1)}ms ` +
      `across ${ITERATIONS} iterations (budget ${MEDIAN_BUDGET_MS}ms)`,
  );
  console.log(
    `[P1F-06] wall-clock samples (ms): ` +
      wallSamples.map((v) => v.toFixed(0)).join(", "),
  );
  console.log(`[P1F-06] per-stage medians (ms):`, stageMedians);

  expect(
    wallMedian,
    `AC-30: median tap-to-submit must be ≤${MEDIAN_BUDGET_MS}ms`,
  ).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
});
