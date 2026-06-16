import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Hits a real Postgres (Supabase/Neon) via DEMO_POSTGRES_URL — the round-trip
// proof for the P1B-05 `getFirstRunCompleted` read backing `GET /me`'s
// `firstRunCompleted` field (API §7.2.5). Skipped when DEMO_POSTGRES_URL is
// unset so CI stays green.

const RUN = !!process.env.DEMO_POSTGRES_URL;

const SPECIALIST_ID = "0058K00000XYZAbQAO";

describe.skipIf(!RUN)("notification-preferences repository (integration)", () => {
  // Lazy-imported so client.ts (which throws on missing DEMO_POSTGRES_URL)
  // never evaluates when the suite is skipped.
  let db: (typeof import("../../src/db/client.js"))["db"];
  let closeDb: (typeof import("../../src/db/client.js"))["closeDb"];
  let repo: typeof import("../../src/repositories/index.js");
  let schema: typeof import("../../src/schema/index.js");

  beforeAll(async () => {
    ({ db, closeDb } = await import("../../src/db/client.js"));
    repo = await import("../../src/repositories/index.js");
    schema = await import("../../src/schema/index.js");
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE notification_preferences`);
  });

  it("returns false when the specialist has no preferences row (gap-aware default)", async () => {
    expect(await repo.getFirstRunCompleted(db, SPECIALIST_ID)).toBe(false);
  });

  it("returns false for a row carrying the first_run_completed column default", async () => {
    await db.insert(schema.notificationPreferences).values({
      specialistId: SPECIALIST_ID,
      updatedBy: SPECIALIST_ID,
    });
    expect(await repo.getFirstRunCompleted(db, SPECIALIST_ID)).toBe(false);
  });

  it("returns true once the specialist has completed the onboarding tour", async () => {
    await db.insert(schema.notificationPreferences).values({
      specialistId: SPECIALIST_ID,
      updatedBy: SPECIALIST_ID,
      firstRunCompleted: true,
    });
    expect(await repo.getFirstRunCompleted(db, SPECIALIST_ID)).toBe(true);
  });
});
