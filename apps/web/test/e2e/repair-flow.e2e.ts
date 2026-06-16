// Verification driver for the Add Repair feature: caseload "+" → Add Repair
// sheet → real Repair__c write (mock SF) → repair on the calendar. Drives the
// real GUI through the same mock-SF + Postgres substrate as the other caseload
// e2es. (The F-07 detail page is not driven here — the synthetic caseload
// fixture doesn't supply every field that page reads; see a11y-demo-path.e2e.ts.
// The profile RepairsPanel + timeline disclosure are covered by component tests.)
//
// Auth: seeds a `sessions` row + sets the `anthos_session` cookie directly,
// bypassing the iframe OAuth round-trip (the session cookie is the plaintext
// token; the BFF looks the row up by its SHA-256 hash).

import { createHash, randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";
import pg from "pg";

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
import {
  BFF_ORIGIN,
  POSTGRES_URL,
  SPECIALIST_ID,
  SPECIALIST_DISPLAY_NAME,
  SPECIALIST_EMAIL,
  SPECIALIST_TIMEZONE,
} from "./_support/constants.js";

async function seedSessionCookie(
  page: import("@playwright/test").Page,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const client = new pg.Client({
    connectionString: POSTGRES_URL,
    ssl: POSTGRES_URL.includes("sslmode=disable")
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO sessions
         (token_hash, specialist_id, role, expires_at, revoked,
          display_name, email, timezone)
       VALUES ($1, $2, 'SPECIALIST', NOW() + INTERVAL '6 hours', false,
          $3, $4, $5)`,
      [
        tokenHash,
        SPECIALIST_ID,
        SPECIALIST_DISPLAY_NAME,
        SPECIALIST_EMAIL,
        SPECIALIST_TIMEZONE,
      ],
    );
  } finally {
    await client.end();
  }
  await page.context().addCookies([
    {
      name: "anthos_session",
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

test.beforeEach(async () => {
  await truncateCaseloadTables();
});

test("caseload + logs a repair and shows it on the calendar", async ({
  page,
}) => {
  const fixture = generateSyntheticCaseload();
  await installSfFixture(buildSoqlFixture(fixture));
  await seedCaseloadCache(buildWarmCaseloadBodies(fixture));
  await seedSessionCookie(page);

  await page.goto(`${BFF_ORIGIN}/caseload`);
  await expect(page.locator('[data-testid="caseload-row"]')).toHaveCount(75);

  // 1. The "+" quick action is labeled Add repair (not Add Barrier).
  const addRepair = page.getByRole("button", { name: "Add repair" }).first();
  await expect(addRepair).toHaveAttribute("title", "Add repair");
  await addRepair.click();

  // 2. The Add Repair sheet opens with just the note field (no destination
  //    selector — the note always routes to Description).
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add Repair" })).toBeVisible();
  await expect(dialog.locator("select")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/repair-1-sheet.png", fullPage: true });

  // 3. Submit the note; the sheet closes on the 201.
  await dialog.locator("textarea").fill("E2E: leaky faucet in unit 4B");
  await dialog.getByRole("button", { name: "Add Repair" }).click();
  await expect(dialog).toBeHidden();

  // 4. Switch to the calendar; the repair shows on today as "Repair logged".
  await page.getByRole("radio", { name: "Calendar" }).click();
  await expect(page.getByText("Repair logged").first()).toBeVisible();
  await page.screenshot({ path: "/tmp/repair-2-calendar.png", fullPage: true });
});
