// Shared "the BFF app frame has settled" predicate for the iframe E2Es.
//
// The Salesforce-Console iframe loads the bare origin `${BFF_ORIGIN}/`, and the
// OAuth callback redirects there too. On the laptop variant the landing then
// client-redirects to `/caseload` (the laptop caseload SPA lives there; `/`
// only routes the device variant — see `LandingSwitch`). So a frame that has
// "settled into the authenticated app" can legitimately be at either URL, and
// every poll that used to hard-match `=== ${BFF_ORIGIN}/` would race the
// redirect on laptop. Centralise the predicate so the call sites can't drift.

import { expect, type Frame, type Page } from "@playwright/test";

import { BFF_ORIGIN } from "./constants.js";

export function isAppFrameUrl(url: string): boolean {
  return url === `${BFF_ORIGIN}/` || url === `${BFF_ORIGIN}/caseload`;
}

export function findAppFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => isAppFrameUrl(f.url()));
}

// Polls until some frame is on the BFF landing (`/`) or the laptop caseload
// redirect target (`/caseload`). Default 30s matches the existing call sites.
export async function waitForAppFrame(
  page: Page,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(() => page.frames().some((f) => isAppFrameUrl(f.url())), { timeout })
    .toBe(true);
}
