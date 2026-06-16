// PF-07 baseline smoke test — satisfies the impl-plan §3 Phase −1 exit
// criterion "Repo green (lint + typecheck + 1 sample unit test passes)".
// Replace with real PriorityEngine unit tests in P0-10.

import { describe, expect, it } from "vitest";

describe("domain package — PF-07 smoke test", () => {
  it("arithmetic sanity check", () => {
    expect(1 + 1).toBe(2);
  });
});
