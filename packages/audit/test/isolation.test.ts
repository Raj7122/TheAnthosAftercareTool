import { describe, expect, it } from "vitest";

// Importing @anthos/audit must NOT evaluate @anthos/persistence's db/client.ts,
// which throws at module-eval time if DEMO_POSTGRES_URL is unset. The writer
// imports the pure `@anthos/persistence/schema` subpath for the auditLog table
// and only `import type`s the db handle (erased at runtime).
describe("@anthos/audit module isolation", () => {
  it("imports with DEMO_POSTGRES_URL unset — no DB-client side effect", async () => {
    const saved = process.env["DEMO_POSTGRES_URL"];
    delete process.env["DEMO_POSTGRES_URL"];
    try {
      const mod = await import("../src/index.js");
      expect(typeof mod.writeAuditEntry).toBe("function");
    } finally {
      if (saved !== undefined) {
        process.env["DEMO_POSTGRES_URL"] = saved;
      }
    }
  });
});
