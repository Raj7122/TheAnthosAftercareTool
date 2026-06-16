// P3B-03 — E2E: tablet variant of the /caseload SPA. The tablet device
// emulation (`devices["iPad (gen 7)"]`) plus the four-signal AND-gate in
// `useDeviceVariant()` swaps `CaseloadList` for `TabletCaseloadList`; the
// data path stays variant-agnostic (no per-variant BFF projection).
//
// Maps to: F-13 (Tablet Field Interface); BR-65 (portrait fit without
// truncation); AC-48 (one-handed touch targets).
//
// Auth + fixture setup mirrors `caseload-perf.e2e.ts` so the tablet path
// exercises the same SSR + hydration boundary the laptop path does. Perf
// envelopes are intentionally not re-asserted here; that's P1C-07's job.

import { expect, test, devices } from "@playwright/test";

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

const { defaultBrowserType: _ipadBrowser, ...IPAD_GEN_7 } =
  devices["iPad (gen 7)"];

async function authenticateInIframe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto(`${MOCK_SF_ORIGIN}/`);
  await waitForAppFrame(page);
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

test.describe("tablet variant", () => {
  test.use(IPAD_GEN_7);

  test("renders the card list (not the 7-column table) and meets the touch-target floor", async ({
    page,
  }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    // The tablet list shell carries `data-variant="tablet"` — its presence
    // is the unambiguous signal that the device-variant switch fired.
    const list = page.locator('[data-testid="caseload-list"]');
    await list.waitFor({ state: "visible" });
    await expect(list).toHaveAttribute("data-variant", "tablet");

    // No `<table>` chrome on the tablet path: the 7-column desktop layout
    // does not render. The list is a `<ul>` of `<li>` cards.
    await expect(page.locator('[data-testid="caseload-list"] thead')).toHaveCount(0);
    await expect(page.locator('[data-testid="caseload-list"] table')).toHaveCount(0);

    // F-13 AC-48: every quick-action button on the first card clears 44px.
    // The tablet QuickActionsRow variant is `h-11`; the 44px floor is what
    // P3B-02 established for tablet secondary-row actions.
    const firstRow = page.locator('[data-testid="caseload-row"]').first();
    const quickButtons = firstRow.locator(
      'button[data-variant="tablet"]',
    );
    const buttonCount = await quickButtons.count();
    expect(buttonCount).toBeGreaterThan(0);
    for (let i = 0; i < buttonCount; i++) {
      const box = await quickButtons.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("the disclosure expands the BR-19 factor breakdown without navigating", async ({
    page,
  }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    const firstRow = page.locator('[data-testid="caseload-row"]').first();
    await firstRow.locator('[data-testid="caseload-row-disclosure"]').click();
    await expect(
      page.locator('[data-testid="factor-breakdown-row"]'),
    ).toBeVisible();
    // The disclosure sits above the card's stretched-link overlay and carries
    // no navigation — the card body click that opens detail must not fire here.
    expect(page.url()).toContain("/caseload");
  });

  test("tapping the card body navigates to the participant detail (BR-41)", async ({
    page,
  }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    const firstRow = page.locator('[data-testid="caseload-row"]').first();
    await firstRow.waitFor({ state: "visible" });
    const href = await firstRow
      .locator('a[href^="/participants/"]')
      .first()
      .getAttribute("href");
    expect(href, "card should carry a participant detail link").toBeTruthy();

    // Tap a non-action region (the tier pill, top-left). The name link's
    // `::before` overlay, anchored to the already-`relative` <li>, makes the
    // whole card the nav target. `force` dispatches at the coordinate so the
    // browser routes it to the topmost element (the overlay).
    await firstRow.click({ position: { x: 12, y: 12 }, force: true });
    await page.waitForURL(`**${href}`);
    expect(page.url()).toContain(href!);
  });
});

test.describe("laptop variant", () => {
  test("default desktop viewport renders the 7-column table, not the card list", async ({
    page,
  }) => {
    await authenticateInIframe(page);
    await page.goto(`${BFF_ORIGIN}/caseload`);

    const list = page.locator('[data-testid="caseload-list"]');
    await list.waitFor({ state: "visible" });

    // The laptop path keeps the P1H-06 `<table>` shell intact.
    await expect(page.locator('[data-testid="caseload-list"] thead th')).toHaveCount(
      7,
    );
    // And does NOT advertise the tablet variant attribute.
    await expect(list).not.toHaveAttribute("data-variant", "tablet");
  });
});
