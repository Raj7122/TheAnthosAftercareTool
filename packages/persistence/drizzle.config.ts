import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// .env lives at the repo root; drizzle-kit runs from packages/persistence/.
loadEnv({ path: "../../.env" });
loadEnv();

// `drizzle-kit generate` only inspects the TS schema; it does not connect.
// Live operations (`drizzle-kit check`, `drizzle-kit migrate`, `pnpm db:migrate`)
// run through scripts/migrate.ts and fail loudly if the URL is empty.
const url = process.env.DEMO_POSTGRES_URL || "postgresql://unset:unset@localhost:5432/unset";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*",
  out: "./src/migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
