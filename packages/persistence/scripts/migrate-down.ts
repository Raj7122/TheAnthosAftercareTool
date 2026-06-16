// Reverses applied Drizzle migrations by executing their sibling *_down.sql.
// Drizzle Kit has no built-in down command; per project convention the additive-only
// rule starts at Phase 1, so Phase-0 reversibility is hand-authored.
//
// Layout:
//   src/migrations/<idx>_<tag>.sql            — forward migration (drizzle-kit generate)
//   src/migrations/down/<idx>_<tag>_down.sql  — paired reverse SQL (hand-authored)
//   src/migrations/meta/_journal.json         — Drizzle Kit's migration journal
//   drizzle.__drizzle_migrations              — Drizzle's tracking table on the DB
//
// Flags:
//   --all   reverse every applied migration in descending order.
//   default reverse only the most recently applied migration.
//
// dotenv MUST populate the environment before `src/db/client.ts` is evaluated:
// client.ts reads DEMO_POSTGRES_URL at module load and throws if it is unset.
// A static `import` of client.js is hoisted above the `loadEnv()` calls — ES
// modules evaluate every import before any top-level statement runs — so the
// client is pulled in via dynamic `import()` inside main(), after the env is
// loaded.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";

loadEnv({ path: "../../.env" });
loadEnv();

const MIGRATIONS_DIR = join(process.cwd(), "src", "migrations");
const DOWN_DIR = join(MIGRATIONS_DIR, "down");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface AppliedMigration {
  id: number;
  hash: string;
}

function loadJournal(): JournalEntry[] {
  // JOURNAL_PATH is a const built from process.cwd() + a hard-coded relative
  // path under our own source tree; not user-controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as { entries: JournalEntry[] };
  return journal.entries;
}

async function listAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  const result = await pool.query<AppliedMigration>(
    `SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id DESC`,
  );
  return result.rows;
}

async function revertOne(
  pool: Pool,
  applied: AppliedMigration,
  entries: JournalEntry[],
): Promise<void> {
  // Drizzle's `id` is 1-indexed by insertion order; journal `idx` is 0-indexed.
  const entry = entries[applied.id - 1];
  if (!entry) {
    throw new Error(
      `Journal entry not found for migration id=${applied.id}. Did the journal drift from the DB?`,
    );
  }
  const downSqlPath = join(DOWN_DIR, `${entry.tag}_down.sql`);
  // entry.tag is sourced from our own committed _journal.json; DOWN_DIR is
  // a hard-coded path under packages/persistence/src/migrations/down. Not
  // user-controlled input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const downSql = readFileSync(downSqlPath, "utf8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(downSql);
    await client.query("DELETE FROM drizzle.__drizzle_migrations WHERE id = $1", [applied.id]);
    await client.query("COMMIT");
    console.log(`↺ Reverted ${entry.tag} (id=${applied.id}) via ${downSqlPath}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { closeDb, pool } = await import("../src/db/client.js");
  try {
    const all = process.argv.includes("--all");
    const applied = await listAppliedMigrations(pool).catch((err: unknown) => {
      if (err instanceof Error && /drizzle\.__drizzle_migrations/.test(err.message)) {
        return [] as AppliedMigration[];
      }
      throw err;
    });
    if (applied.length === 0) {
      console.log("No migrations applied — nothing to reverse.");
      return;
    }
    const entries = loadJournal();
    const targets = all ? applied : applied.slice(0, 1);
    for (const m of targets) {
      await revertOne(pool, m, entries);
    }
  } finally {
    // A close failure must not mask a migrate-down error.
    await closeDb().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("✗ Migrate-down failed:", err);
  process.exitCode = 1;
});
