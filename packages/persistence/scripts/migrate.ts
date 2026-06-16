// Applies all pending Drizzle migrations forward.
// Usage: pnpm db:migrate (from repo root) or pnpm --filter @anthos/persistence db:migrate.
//
// dotenv MUST populate the environment before `src/db/client.ts` is evaluated:
// client.ts reads DEMO_POSTGRES_URL at module load and throws if it is unset.
// A static `import` of client.js is hoisted above the `loadEnv()` calls — ES
// modules evaluate every import before any top-level statement runs — so the
// client is pulled in via dynamic `import()` inside main(), after the env is
// loaded.
import { config as loadEnv } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";

loadEnv({ path: "../../.env" });
loadEnv();

async function main(): Promise<void> {
  const { closeDb, db } = await import("../src/db/client.js");
  try {
    await migrate(db, { migrationsFolder: "./src/migrations" });
    console.log("✓ Forward migrations applied.");
  } finally {
    // A close failure must not mask a migration error.
    await closeDb().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err);
  process.exitCode = 1;
});
