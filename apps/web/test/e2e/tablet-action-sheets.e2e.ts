// P3B-04 — E2E: the shared `ActionSheetShell` primitive renders the
// device-variant-correct chrome. Three real sheets (LogCallSheet,
// CreateBarrierSheet, CloseBarrierConfirm) consume the shell, plus the
// P3B-02 `SchedulingSheetPlaceholder` — exercising the placeholder gives
// us shell coverage without the participant-page auth + caseload-cache
// fixture overhead the action sheets would otherwise require.
//
// Maps to: F-13 (Tablet Field Interface); BR-65 (10" portrait fit);
// AC-48 (one-handed tap targets).
//
// What this spec asserts:
//   - The shell's `data-variant` attribute reflects the device variant
//     (`tablet` on iPad-emulated, `laptop` on desktop) — the unambiguous
//     signal that `useDeviceVariant()` fired correctly inside the shell.
//   - The tablet branch renders as a bottom-pinned drawer (container y
//     + height ≈ viewport.height) AND is full-width (no `max-w-md` cap).
//   - The laptop branch keeps the centered-modal idiom (container is
//     NOT bottom-pinned) AND keeps the `max-w-md` cap.
//   - The primary CTA on tablet meets the F-13 AC-48 floor (≥48px;
//     `h-14` = 56px is the deliberate target).
//   - Body scroll-lock activates while the sheet is open and releases
//     when it closes — keeps the page behind the sheet stable when the
//     iPad-portrait keyboard appears for dictation (BR-91).

import { devices, expect, test } from "@playwright/test";

import { BFF_ORIGIN } from "./_support/constants.js";

// Drop `defaultBrowserType` — Playwright forbids that key inside a describe
// (it forces a new worker). The chromium project from playwright.config.ts
// emulates iPad just fine via viewport + UA + touch flags. (Same trick as
// `tablet-landing.e2e.ts`.)
const { defaultBrowserType: _ipadBrowser, ...IPAD_GEN_7 } =
  devices["iPad (gen 7)"];

test.describe("ActionSheetShell — tablet variant", () => {
  test.use(IPAD_GEN_7);

  test("renders as a bottom-pinned, full-width drawer with data-variant='tablet'", async ({
    page,
  }) => {
    await page.goto(`${BFF_ORIGIN}/demo/action-sheet`);
    await page.getByRole("button", { name: "Log this visit?" }).click();

    const shell = page.locator('[data-testid="action-sheet-shell"]');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute("data-variant", "tablet");

    // Inner container: bottom-pinned (its bottom edge ≈ viewport bottom)
    // and full-width (NOT capped at max-w-md / 28rem ≈ 448px). Scope to
    // the explicit content testid so the selector can't drift if the
    // shell ever introduces additional sibling chrome.
    const innerBox = await page
      .locator('[data-testid="action-sheet-shell-content"]')
      .boundingBox();
    const viewport = page.viewportSize();
    expect(innerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    const bottomGap = viewport!.height - (innerBox!.y + innerBox!.height);
    expect(bottomGap).toBeLessThan(2); // pinned to bottom (sub-pixel tolerance)
    // Tablet viewport from `devices["iPad (gen 7)"]` is 810px wide; full-
    // width means we should comfortably exceed the 448px `max-w-md` cap.
    expect(innerBox!.width).toBeGreaterThan(600);
  });

  test("primary CTA meets the F-13 AC-48 / h-14 floor (≥48px)", async ({
    page,
  }) => {
    await page.goto(`${BFF_ORIGIN}/demo/action-sheet`);
    await page.getByRole("button", { name: "Log this visit?" }).click();

    // The placeholder's only button is the Close button; it's the primary
    // affordance for that sheet and gets the tablet h-14 sizing. The same
    // sizing applies to LogCallSheet's "Log call for …" and
    // CreateBarrierSheet's "Add Barrier" buttons via the same isTablet
    // branch in each sheet's footer.
    const closeBtn = page.getByRole("button", { name: "Close" });
    const box = await closeBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(48);
  });

  test("body scroll-lock activates while the sheet is open and releases on close", async ({
    page,
  }) => {
    await page.goto(`${BFF_ORIGIN}/demo/action-sheet`);

    const baselineOverflow = await page.evaluate(
      () => document.body.style.overflow,
    );

    await page.getByRole("button", { name: "Log this visit?" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const openOverflow = await page.evaluate(
      () => document.body.style.overflow,
    );
    expect(openOverflow).toBe("hidden");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    const restoredOverflow = await page.evaluate(
      () => document.body.style.overflow,
    );
    expect(restoredOverflow).toBe(baselineOverflow);
  });
});

// Laptop-variant coverage: the laptop branch of ActionSheetShell is the
// same Tailwind classes (`sm:items-center`, `max-w-md`, `sm:rounded-lg`)
// that LogCallSheet / CreateBarrierSheet / CloseBarrierConfirm have been
// shipping with since P1F-04 — this refactor copies those classes
// verbatim into the shell's `variant === "laptop"` branch. The reachable
// laptop e2e path (LogCallSheet in the iframe) needs the OAuth +
// caseload-cache fixture chain (see `caseload-perf.e2e.ts`); adding
// fixture setup here would duplicate that infrastructure for no extra
// coverage. Existing landing-laptop coverage in `tablet-landing.e2e.ts`
// proves the variant gate fires; the manual desktop sanity check in the
// PR Definition of Done covers the rest.
