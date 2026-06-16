// Verification driver for the Log Case Note feature: caseload 📝 → Log Case Note
// sheet → real IDW_Case_Note__c write (mock SF) → case note on the calendar.
// Mirrors repair-flow.e2e.ts: seeds a session + cookie to bypass the iframe
// OAuth round-trip. The mock SF's createRecord handler already answers for any
// sobject (incl. IDW_Case_Note__c), and the PE-owner query returns the fixture
// enrollments owned by SPECIALIST_ID, so authz passes — no mock change needed.

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

test("caseload 📝 logs a case note and shows it on the calendar", async ({
  page,
}) => {
  const fixture = generateSyntheticCaseload();
  await installSfFixture(buildSoqlFixture(fixture));
  await seedCaseloadCache(buildWarmCaseloadBodies(fixture));
  await seedSessionCookie(page);

  await page.goto(`${BFF_ORIGIN}/caseload`);
  await expect(page.locator('[data-testid="caseload-row"]')).toHaveCount(75);

  // 1. The 📝 quick action is labeled Log case note.
  const logCaseNote = page
    .getByRole("button", { name: "Log case note" })
    .first();
  await expect(logCaseNote).toHaveAttribute("title", "Log case note");
  await logCaseNote.click();

  // 2. The Log Case Note sheet opens with the note field + three picklists.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Log Case Note" })).toBeVisible();
  await expect(dialog.locator("select")).toHaveCount(3);
  await page.screenshot({ path: "/tmp/case-note-1-sheet.png", fullPage: true });

  // 3. Submit a note (defaults Phone / Check In / Completed); sheet closes on 201.
  await dialog.locator("textarea").fill("E2E: quarterly stability check-in");
  await dialog.getByRole("button", { name: "Log Case Note" }).click();
  await expect(dialog).toBeHidden();

  // 4. Switch to the calendar; the case note shows on today as "Case note logged".
  await page.getByRole("radio", { name: "Calendar" }).click();
  await expect(page.getByText("Case note logged").first()).toBeVisible();
  await page.screenshot({ path: "/tmp/case-note-2-calendar.png", fullPage: true });
});
