import type { db } from "./client.js";

// The root Drizzle client. `import type` keeps this file free of the
// connection side effect in client.ts (which throws if DEMO_POSTGRES_URL is
// unset) — types are erased at runtime.
export type DbClient = typeof db;

// A handle that is either the root client or a transaction object. Repository
// and writer functions accept this so a caller can compose a write into an
// existing transaction (Pattern B: audit INSERT + mutation in one boundary).
export type DbOrTx =
  | DbClient
  | Parameters<Parameters<DbClient["transaction"]>[0]>[0];
