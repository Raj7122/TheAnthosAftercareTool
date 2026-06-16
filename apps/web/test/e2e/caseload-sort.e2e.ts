// E2E: sticky + sortable headers on the desktop /caseload table.
//
// Maps to: the "Sticky + Sortable Caseload Headers" ticket — sticky header
// stays pinned while scrolling; five columns are user-sortable with a
// tri-state cycle (default → asc → desc → default); aria-sort + a polite
// live region expose the state; default returns the exact BR-21 server order
// (prioritization logic unchanged).
//
// Auth + fixture setup mirrors `tablet-caseload.e2e.ts`. The synthetic
// caseload round-robins tier 1/2/3 over a priority-descending list, so a Tier
// sort reorders deterministically while the third click restores the seeded
// order exactly — a fixture-agnostic proof that "default" is the server order.

import { expect, test } from "@playwright/test";

import {
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

async function authenticateInIframe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto(`${MOCK_SF_ORIGIN}/`);
  await waitForAppFrame(page);
}

// Ordered list of participant-detail hrefs, top to bottom — a stable proxy
// for row order that does not depend on rendered (PII-stripped) names.
async function rowOrder(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page
    .locator('[data-testid="caseload-list"] tbody a[href^="/participants/"]')
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
}

test.beforeEach(async () => {
  await truncateCaseloadTables();
  await installSfFixture({
    enrollments: [],
    barriers: [],
    incidents: [],
    arrears: [],
    repairs: [],
  });
  const fixture = generateSyntheticCaseload();
  const bodies = buildWarmCaseloadBodies(fixture);
  await seedCaseloadCache(bodies);
});

test.describe("desktop sortable headers", () => {
  test("tri-state Tier sort: asc → desc → back to the seeded server order", async ({
    page,
  }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    const tierHeader = page.locator("thead th", { has: page.locator('[data-testid="caseload-sort-tier"]') });
    const status = page.locator('[data-testid="caseload-sort-status"]');
    const sortButton = page.locator('[data-testid="caseload-sort-tier"]');

    await page.locator('[data-testid="caseload-list"]').waitFor({ state: "visible" });
    const defaultOrder = await rowOrder(page);
    await expect(tierHeader).toHaveAttribute("aria-sort", "none");

    // Click 1 → ascending.
    await sortButton.click();
    await expect(tierHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(status).toHaveText("Sorted by Tier ascending");
    const ascOrder = await rowOrder(page);
    expect(ascOrder).not.toEqual(defaultOrder);
    expect([...ascOrder].sort()).toEqual([...defaultOrder].sort()); // same set

    // Click 2 → descending.
    await sortButton.click();
    await expect(tierHeader).toHaveAttribute("aria-sort", "descending");
    await expect(status).toHaveText("Sorted by Tier descending");
    expect(await rowOrder(page)).not.toEqual(ascOrder);

    // Click 3 → default; the exact seeded (priority-desc) order returns.
    await sortButton.click();
    await expect(tierHeader).toHaveAttribute("aria-sort", "none");
    await expect(status).toHaveText("Default order");
    expect(await rowOrder(page)).toEqual(defaultOrder);
  });

  test("selecting a different column resets the previous header", async ({
    page,
  }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    const tierHeader = page.locator("thead th", { has: page.locator('[data-testid="caseload-sort-tier"]') });
    const participantHeader = page.locator("thead th", { has: page.locator('[data-testid="caseload-sort-participant"]') });

    await page.locator('[data-testid="caseload-sort-tier"]').click();
    await expect(tierHeader).toHaveAttribute("aria-sort", "ascending");

    await page.locator('[data-testid="caseload-sort-participant"]').click();
    await expect(tierHeader).toHaveAttribute("aria-sort", "none");
    await expect(participantHeader).toHaveAttribute("aria-sort", "ascending");
  });

  test("keyboard activates sort (Enter and Space)", async ({ page }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    const tierHeader = page.locator("thead th", { has: page.locator('[data-testid="caseload-sort-tier"]') });
    const sortButton = page.locator('[data-testid="caseload-sort-tier"]');

    await sortButton.focus();
    await page.keyboard.press("Enter");
    await expect(tierHeader).toHaveAttribute("aria-sort", "ascending");
    await page.keyboard.press("Space");
    await expect(tierHeader).toHaveAttribute("aria-sort", "descending");
  });

  test("header stays pinned while the caseload scrolls", async ({ page }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    const scroll = page.locator('[data-testid="caseload-scroll"]');
    await scroll.waitFor({ state: "visible" });

    // 75 synthetic rows overflow the bounded scroll region.
    const overflows = await scroll.evaluate(
      (el) => el.scrollHeight > el.clientHeight,
    );
    expect(overflows, "scroll region should overflow with 75 rows").toBe(true);

    await scroll.evaluate((el) => {
      el.scrollTop = 400;
    });

    // After scrolling, the sticky <th> stays pinned at (≈) the top of the
    // scroll container rather than scrolling out of view.
    const th = scroll.locator("thead th").first();
    const thBox = await th.boundingBox();
    const containerBox = await scroll.boundingBox();
    expect(thBox).not.toBeNull();
    expect(containerBox).not.toBeNull();
    expect(Math.abs(thBox!.y - containerBox!.y)).toBeLessThanOrEqual(4);
  });
});
