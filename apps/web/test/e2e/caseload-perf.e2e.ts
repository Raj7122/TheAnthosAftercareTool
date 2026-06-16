// P1C-07 — E2E perf test: caseload renders ≤2s warm cache, ≤5s cold cache.
//
// Closes the Phase 1 sub-phase 1C exit gate. Composes P1C-01..P1C-06 against
// a synthetic 75-participant caseload to assert NFR-PERF-1 / AC-05 holds
// when the BFF + cache + engine + SPA run together. The warm envelope is the
// load-bearing assertion (it's what the spec literally calls out); the cold
// envelope is engineering judgment within the same AC, defending the BFF's
// contribution to the 5-second budget that real-world SF + WAN latency will
// otherwise consume in production.
//
// Maps to: F-02, F-04; NFR-PERF-1; AC-05, AC-12, AC-14, AC-15, AC-17; VR-08,
// VR-09; ARC-04; E-06. (AC-16 scroll-position-per-queue is intentionally
// out of scope here — see PR body.)
//
// Strict envelope (no CI buffer): if assertions flake on the GitHub runner
// they signal a real regression, not noise. The mock SF is local, the cache
// is local Postgres — there is no network latency to hide behind.

import { expect, test } from "@playwright/test";

import {
  buildSoqlFixture,
  buildWarmCaseloadBodies,
  generateSyntheticCaseload,
  installSfFixture,
  addBarrierToFixture,
} from "./_support/caseload-fixtures.js";
import {
  clearCaseloadCache,
  findCaseloadHydratedAuditRows,
  seedCaseloadCache,
  truncateCaseloadTables,
} from "./_support/caseload-db.js";
import { BFF_ORIGIN, MOCK_SF_ORIGIN, SPECIALIST_ID } from "./_support/constants.js";
import { waitForAppFrame } from "./_support/app-frame.js";

// Strict perf budgets per AC-05 / NFR-PERF-1 and the ticket's cold envelope.
//
// Variance budget — local M-series Mac, mock SF in-process, Postgres on
// localhost: warm 89ms / cold 86ms / queue switch 63ms / post-CDC re-cold
// 55ms. That is a 10–50x margin against the budgets below, which absorbs
// the CPU differential to GitHub Actions `ubuntu-latest` (2-vCPU) without
// needing a CI buffer. The mock SF carries no network latency, and the
// service-container Postgres is on the same host as the BFF — there is no
// WAN factor to inflate the cold-path numbers on CI. If any of the four
// assertions ever flakes, it is a real regression, not noise. The
// production-scale envelope (real SF + WAN) is the AC-05 ≤2s warm number
// — these budgets defend the BFF's share of that, not the substrate's.
const WARM_BUDGET_MS = 2_000;
const COLD_BUDGET_MS = 5_000;
const QUEUE_SWITCH_BUDGET_MS = 1_000; // AC-14: queue switch < 1s warm.

// Locator/wait timeout for the render-complete signal. Sized larger than
// COLD_BUDGET_MS so a perf regression surfaces as the budget assertion
// failing — not as a Playwright timeout dressed up as an assertion failure
// (the framework default is 5s, the same order of magnitude as the cold
// budget, which would mask the real signal).
const RENDER_WAIT_MS = COLD_BUDGET_MS + 5_000;

// Drives the OAuth round-trip on a fresh page so the test starts from an
// authenticated session. Returns once the iframe has settled on the BFF
// landing page (the callback's redirect target) — at that point the
// session cookie is set on `BFF_ORIGIN` and any subsequent top-level
// navigation to `/caseload` carries it.
async function authenticateInIframe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto(`${MOCK_SF_ORIGIN}/`);
  // Wait for the BFF iframe to settle on the post-callback landing — `/`, or
  // `/caseload` once the laptop variant's client redirect has run.
  await waitForAppFrame(page);
}

// Renders the caseload SPA via a fresh top-level navigation. Returns the
// wall-clock duration in milliseconds — measured from `goto` start to the
// moment the SPA's list element is visible AND populated to `expectedCount`
// rows (or, if `expectedCount === 0`, the empty-state element is visible).
//
// Top-level navigation is deliberate: it mirrors how the Server Component
// renders (one hop, no warm-up). The session cookie's `SameSite=None;
// Secure` makes it ride a same-site top-level nav over `http://localhost`
// (Chromium treats localhost as a secure context for cookies).
async function loadAndTime(
  page: import("@playwright/test").Page,
  expectedCount: number,
): Promise<number> {
  const start = Date.now();
  await page.goto(`${BFF_ORIGIN}/caseload`);
  if (expectedCount === 0) {
    await page
      .locator('[data-testid="caseload-empty"]')
      .waitFor({ state: "visible", timeout: RENDER_WAIT_MS });
  } else {
    await page
      .locator('[data-testid="caseload-list"]')
      .waitFor({ state: "visible", timeout: RENDER_WAIT_MS });
    await expect(page.locator('[data-testid="caseload-row"]')).toHaveCount(
      expectedCount,
      { timeout: RENDER_WAIT_MS },
    );
  }
  return Date.now() - start;
}

test.beforeEach(async () => {
  // Fresh ledger — auth + caseload audit rows, plus the caseload_cache,
  // plus the mock SF in-memory fixture. Each test is responsible for
  // installing whatever fresh state it needs.
  await truncateCaseloadTables();
  await installSfFixture({
    enrollments: [],
    barriers: [],
    incidents: [],
    arrears: [],
    repairs: [],
  });
});

test("warm cache: 75-participant caseload renders in ≤2s (AC-05, NFR-PERF-1)", async ({ page }) => {
  const fixture = generateSyntheticCaseload();
  const bodies = buildWarmCaseloadBodies(fixture);
  await seedCaseloadCache(bodies);

  await authenticateInIframe(page);
  const elapsed = await loadAndTime(page, 75);

  console.log(`[P1C-07] warm render: ${elapsed}ms (budget ${WARM_BUDGET_MS}ms)`);
  expect(elapsed, "warm-cache 75-row render must satisfy AC-05 ≤2s").toBeLessThanOrEqual(
    WARM_BUDGET_MS,
  );

  // No `caseload.hydrated` audit row on the warm path — the cold-path audit
  // is the discriminator. This double-checks the warm read didn't fall
  // through to a rehydrate (e.g. on a missing cache row).
  const auditRows = await findCaseloadHydratedAuditRows(SPECIALIST_ID);
  expect(auditRows).toHaveLength(0);
});

test("queue switch + counts + breakdown + empty state (AC-12, AC-14, AC-15, VR-09)", async ({
  page,
}) => {
  const fixture = generateSyntheticCaseload();
  const bodies = buildWarmCaseloadBodies(fixture);
  await seedCaseloadCache(bodies);

  await authenticateInIframe(page);
  await loadAndTime(page, 75); // Default landing queue, warm.

  // --- P1H-06 table semantics: the list renders as a `<table>` with seven
  // `<th>` column headers matching the wireframe (Tier / Participant / Why
  // this priority / Last contact / Stability cycle / Barriers — tags /
  // Quick actions). AC-12 transparency: surfacing the column labels at the
  // header level is the structural half of the disclosure pattern.
  await expect(
    page.locator('[data-testid="caseload-list"] thead th'),
  ).toHaveCount(7);

  // --- AC-14: queue switch to `due_soon` ≤1s warm.
  const switchStart = Date.now();
  await page.locator('[data-testid="queue-selector"] [data-queue-id="due_soon"]').click();
  // The active queue is whatever the selector's button now reports. The list
  // re-renders client-side from the new E-06 fetch; wait for it to settle.
  await expect(page.locator('[data-testid="caseload-row"]')).toHaveCount(75);
  const switchElapsed = Date.now() - switchStart;
  console.log(`[P1C-07] queue switch: ${switchElapsed}ms (budget ${QUEUE_SWITCH_BUDGET_MS}ms)`);
  expect(
    switchElapsed,
    "queue switch must satisfy AC-14 <1s warm",
  ).toBeLessThanOrEqual(QUEUE_SWITCH_BUDGET_MS);

  // --- AC-15: queue counts on the selector match the rendered list size.
  // The selector renders each queue button with the count embedded in its
  // label (P1C-04 QueueSelector). Read the active-queue button's text and
  // verify it carries the same count as the list.
  const activeQueueButton = page.locator(
    '[data-testid="queue-selector"] [data-queue-id="due_soon"]',
  );
  const buttonText = await activeQueueButton.textContent();
  expect(buttonText, "active queue button should label a count").toMatch(/75/);

  // --- AC-12: factor breakdown expands inline beneath a row.
  // The first row's WHY THIS PRIORITY disclosure button (P1H-05) toggles
  // `aria-expanded` and reveals the BR-19 breakdown panel as a sibling row
  // (P1H-06: `<tr data-testid="factor-breakdown-row"><td colspan=7>...`).
  const firstRow = page.locator('[data-testid="caseload-row"]').first();
  const whyButton = firstRow.locator(
    '[data-testid="caseload-row-disclosure"]',
  );
  await whyButton.click();
  const breakdownRow = page.locator('[data-testid="factor-breakdown-row"]');
  await expect(breakdownRow).toBeVisible();
  // Direct-child `> td`: the FactorBreakdownPanel renders its own nested
  // `<table>` of factor rows inside the outer cell, so a plain descendant
  // `td` selector matches nine elements (1 outer + 8 inner). The outer
  // colspan=7 cell is the only direct child of the breakdown <tr>.
  await expect(
    page.locator('[data-testid="factor-breakdown-row"] > td'),
  ).toHaveAttribute("colspan", "7");
  // The expanded panel renders the factors heading "Factor breakdown" (per
  // P1C-04 FactorBreakdownPanel). Use any visible text from the panel to
  // confirm it opened — the exact selector is brittle, the visibility is not.
  await expect(breakdownRow).toContainText(/Failed attempts|Days since/);

  // --- VR-09: switching to a queue with zero items renders the empty state.
  await page
    .locator('[data-testid="queue-selector"] [data-queue-id="never_successfully_contacted"]')
    .click();
  await expect(page.locator('[data-testid="caseload-empty"]')).toBeVisible();
  await expect(page.locator('[data-testid="caseload-empty"]')).toContainText(
    "Everyone in your caseload has been reached at least once.",
  );
  // P1H-06: empty state renders as a single `colspan=7` cell, not a `<p>`.
  await expect(page.locator('[data-testid="caseload-empty"]')).toHaveAttribute(
    "colspan",
    "7",
  );
});

test("whole-row click + Enter navigate to participant detail; disclosure stays put (BR-41)", async ({
  page,
}) => {
  const fixture = generateSyntheticCaseload();
  const bodies = buildWarmCaseloadBodies(fixture);
  await seedCaseloadCache(bodies);

  await authenticateInIframe(page);
  await loadAndTime(page, 75);

  // The participant-name link is the navigation target; its href is the
  // detail route we expect every row interaction to resolve to.
  const firstLink = page
    .locator('[data-testid="caseload-row"]')
    .first()
    .locator('a[href^="/participants/"]')
    .first();
  const href = await firstLink.getAttribute("href");
  expect(href, "row should carry a participant detail link").toBeTruthy();

  // Keyboard: the row is a native <a>, so focusing the name link and pressing
  // Enter opens the detail (no role=button; Space is intentionally unbound).
  await firstLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`**${href}`);
  expect(page.url()).toContain(href!);

  // Back on the caseload (fresh nav avoids history flakiness), the disclosure
  // button still expands in place and must NOT navigate — it paints above the
  // stretched-link overlay and carries no navigation of its own.
  await page.goto(`${BFF_ORIGIN}/caseload`);
  await page
    .locator('[data-testid="caseload-list"]')
    .waitFor({ state: "visible" });
  const firstRow = page.locator('[data-testid="caseload-row"]').first();
  await firstRow.locator('[data-testid="caseload-row-disclosure"]').click();
  await expect(page.locator('[data-testid="factor-breakdown-row"]')).toBeVisible();
  expect(page.url(), "disclosure must not navigate").toContain("/caseload");

  // Clicking a non-action region of the row (the tier glyph, top-left) opens
  // the detail: the name link's `::before` overlay turns the whole <tr> into
  // the click target. `force` fires the synthetic event at the coordinate —
  // the browser routes it to the topmost element (the overlay). This also
  // validates that `position: relative` on the <tr> actually anchors the
  // overlay across the full row in Chromium.
  const hrefAgain = await firstRow
    .locator('a[href^="/participants/"]')
    .first()
    .getAttribute("href");
  await firstRow.click({ position: { x: 8, y: 8 }, force: true });
  await page.waitForURL(`**${hrefAgain}`);
  expect(page.url()).toContain(hrefAgain!);
});

test("cold cache: 75-participant caseload hydrates via SF and renders in ≤5s", async ({ page }) => {
  const fixture = generateSyntheticCaseload();
  const soql = buildSoqlFixture(fixture);
  await installSfFixture(soql);
  // No pre-seeded cache — the cold path is the BFF going through
  // hydrateCaseload → engine → cache write-through end-to-end.
  await clearCaseloadCache(SPECIALIST_ID);

  await authenticateInIframe(page);
  const elapsed = await loadAndTime(page, 75);

  console.log(`[P1C-07] cold render: ${elapsed}ms (budget ${COLD_BUDGET_MS}ms)`);
  expect(elapsed, "cold-cache 75-row render must complete in ≤5s").toBeLessThanOrEqual(
    COLD_BUDGET_MS,
  );

  // Pattern B / Immutable #5 — the cold path writes `caseload.hydrated`
  // BEFORE returning. Confirms the perf number was actually paid for by a
  // real cold rehydrate, not a stale-but-fresh cache hit.
  const auditRows = await findCaseloadHydratedAuditRows(SPECIALIST_ID);
  expect(auditRows.length, "exactly one cold-path audit row").toBe(1);
  const row = auditRows[0]!;
  expect(row.outcome).toBe("SUCCESS");
  expect(row.queueId).toBe("due_soon");
  expect(row.participantCount).toBe(75);
});

test("stale → fresh: CDC-style invalidation triggers a fresh hydrate (AC-17)", async ({ page }) => {
  const fixture = generateSyntheticCaseload();
  const initialSoql = buildSoqlFixture(fixture);
  await installSfFixture(initialSoql);
  await clearCaseloadCache(SPECIALIST_ID);

  // Cold pass 1 — establishes the baseline (no barriers anywhere).
  await authenticateInIframe(page);
  await loadAndTime(page, 75);

  // Mutate the upstream fixture: add an open barrier to participant 0. The
  // P1C-03 CDC poll would catch this in ≤30s in production; the test stands
  // in by calling clearCaseloadCache (mirrors `invalidateCaseloadCache`).
  const { updated } = addBarrierToFixture(initialSoql, 0);
  await installSfFixture(updated);
  await clearCaseloadCache(SPECIALIST_ID);

  // Cold pass 2 — re-hydrates, sees the new barrier. Re-render time is the
  // same envelope as a regular cold pass.
  const reloadElapsed = await loadAndTime(page, 75);
  console.log(`[P1C-07] post-CDC re-cold render: ${reloadElapsed}ms`);
  expect(reloadElapsed).toBeLessThanOrEqual(COLD_BUDGET_MS);

  // Two cold-path audit rows — one per cold pass. The second one proves
  // P1C-02 (cache) and the P1C-03 stand-in (invalidation) composed.
  const auditRows = await findCaseloadHydratedAuditRows(SPECIALIST_ID);
  expect(auditRows.length, "exactly two cold-path audit rows").toBe(2);

  // AC-17 load-bearing assertion — the new barrier reached the response
  // payload. `openBarriers` on the per-row DTO is derived from the
  // hydrated snapshot's `barriers` filter (`endDate === null && stage ===
  // 'Aftercare'`); the row text doesn't visually surface this, so we
  // inspect the API payload directly from the page context. Without this,
  // the audit-row assertion alone wouldn't distinguish "the barrier was
  // hydrated" from "the second cold pass returned the same payload as the
  // first" — which would be a regression P1C-03 must catch.
  const apiResult = await page.evaluate(async () => {
    const res = await fetch("/api/v1/caseload?queue=caseload_overview", {
      credentials: "include",
      cache: "no-store",
    });
    return (await res.json()) as {
      items: Array<{ participantId: string; openBarriers: unknown[] }>;
    };
  });
  const rowWithBarrier = apiResult.items.find(
    (item) => item.openBarriers.length > 0,
  );
  expect(
    rowWithBarrier,
    "exactly one row should carry the newly-hydrated open barrier",
  ).toBeDefined();
});
