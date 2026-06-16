// P3B-02 + P3C-13 tablet "Today" home — E2E: the tablet variant renders the
// live field-card surface on a portrait iPad-class device.
//
// The laptop variant of `/` no longer renders a standalone landing — it
// client-redirects to the `/caseload` SPA (LandingSwitch). That redirect
// decision is unit-tested (`LandingSwitch.test.tsx`), and the authenticated
// laptop `/` → `/caseload` hand-off is exercised end-to-end by the iframe
// specs (`a11y-demo-path`, `caseload-perf`, `caseload-sort`, `log-call-perf`).
// Asserting it from THIS unauthenticated session would chase the cross-origin
// OAuth bounce `/caseload` triggers on a 401 — exactly the redirect chain this
// suite avoids — so there is no laptop case here.
//
// `/` deliberately stays SSR 200 OK on every request (no *server* redirect
// chain; the Playwright webServer URL probe and an unauthenticated test
// session both need a fast 200; the variant redirects are client-side and
// never reach the probe).
//
// Client-side redirects on an UNAUTHENTICATED `/` (post-hydration):
//   - laptop → `/caseload` (which then OAuth-bounces on its 401), and
//   - tablet → `/api/v1/auth/login` (so a field device signs in *before*
//     seeing its caseload, rather than landing on a misleading demo screen
//     whose "Open" buttons dead-end at 404 — the bug this suite now guards).
// To exercise the rendered tablet surface from an unauthenticated session we
// use the `?demo=sf` walkthrough path, which is exempt from the login bounce
// and still falls back to demo fixtures (server data stays empty either way).
// In that path:
//   - the top-priority hero shows its "all caught up" empty state,
//   - the Pending Sync panel shows its empty hint, and
//   - the collapsed caseload falls back to demo fixtures.
// The authenticated hero "Log notes" → Quick Log sheet → offline-queue →
// Synced-✓ flow is covered by the unit suites (tablet-landing / quick-log-sheet
// / use-outbox / replay / with-outbox-mirror) and the device-level demo
// verification steps in the P3C-13 ticket; it can't run from an unauthenticated
// webServer session. The non-demo tablet render (no SF chrome) is unit-covered
// by `LandingSwitch.test.tsx`.

import { expect, test, devices } from "@playwright/test";

import { BFF_ORIGIN } from "./_support/constants.js";

// Drop `defaultBrowserType` — Playwright forbids that key inside a describe
// (it forces a new worker). The chromium project from playwright.config.ts
// emulates iPad just fine via viewport + UA + touch flags.
const { defaultBrowserType: _ipadBrowser, ...IPAD_GEN_7 } = devices["iPad (gen 7)"];

test.describe("tablet variant", () => {
  test.use(IPAD_GEN_7);

  test("bounces an unauthenticated tablet to the OAuth login", async ({ page }) => {
    // The redirect target 302s cross-origin to Salesforce; assert the request
    // is *initiated* (set up before navigation so the post-hydration assign
    // isn't missed) rather than following the bounce to completion.
    const loginRequest = page.waitForRequest((req) => req.url().includes("/api/v1/auth/login"));
    await page.goto(`${BFF_ORIGIN}/`);
    const req = await loginRequest;
    // returnTo round-trips the tablet back to its landing post-login.
    expect(req.url()).toContain("returnTo=%2F%3Fview%3Dtablet");
  });

  test("renders the top-priority hero (empty state) on the ?demo=sf path", async ({ page }) => {
    await page.goto(`${BFF_ORIGIN}/?demo=sf`);

    const hero = page.getByTestId("top-priority-card");
    await expect(hero).toBeVisible();
    // No caseload item to act on in the unauthenticated session.
    await expect(hero).toHaveAttribute("data-empty", "true");
    await expect(hero).toContainText("All caught up");
  });

  test("renders the Pending Sync panel with its empty hint", async ({ page }) => {
    await page.goto(`${BFF_ORIGIN}/?demo=sf`);

    await expect(page.getByTestId("pending-queue-panel")).toBeVisible();
    await expect(page.getByTestId("pending-queue-empty")).toBeVisible();

    // No queued work → no header pending badge.
    await expect(page.getByTestId("tablet-header-pending-badge")).toHaveCount(0);
  });

  test("renders the demo-fallback caseload when no F-02 data is hydrated", async ({ page }) => {
    await page.goto(`${BFF_ORIGIN}/?demo=sf`);

    const caseload = page.getByTestId("collapsed-caseload");
    await expect(caseload).toBeVisible();
    // Unauthenticated test session → empty initialCaseloadItems → fallback.
    await expect(caseload).toHaveAttribute("data-using-real-data", "false");
    await expect(caseload).toContainText("Mileena Lesane");
  });

  test("?demo=sf opts into the fake SF Mobile chrome wrapper", async ({ page }) => {
    await page.goto(`${BFF_ORIGIN}/?demo=sf`);

    // The chrome bar surfaces the "Stability Visit · 2:00 PM" demo header
    // copy from SfMobileChrome.
    await expect(page.getByText("Stability Visit · 2:00 PM")).toBeVisible();
    // Tablet view still renders inside the wrapper.
    await expect(page.getByTestId("top-priority-card")).toBeVisible();
  });
});
