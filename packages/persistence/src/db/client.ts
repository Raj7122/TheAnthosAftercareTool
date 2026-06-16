import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../schema/index.js";

const connectionString = process.env.DEMO_POSTGRES_URL;
if (!connectionString) {
  throw new Error(
    "DEMO_POSTGRES_URL is not set. Copy .env.example to .env and populate the Supabase/Neon connection string (see PF-02).",
  );
}

// Supabase / Neon require TLS. node-postgres accepts ssl from the URL
// (`?sslmode=require`); set a permissive default for managed providers
// where the cert chain is not bundled locally.
export const pool = new pg.Pool({
  connectionString,
  ssl: connectionString.includes("sslmode=disable")
    ? false
    : { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
}
