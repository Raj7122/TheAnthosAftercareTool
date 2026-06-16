import { describe, expect, it } from "vitest";

import { sbopFactor } from "../../../src/priority/factors/sbop.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

// BR-21 / Pattern F — SBOP stub-and-ratchet invariants.
// The factor MUST contribute exactly 0 priority points while sbop_enabled
// is false (the default). Engine determinism MUST hold at both flag states.
// The flag flips on Anthos leadership ratification of BR-21 (GAP-9), NOT
// on Demo→Production migration. Until then the enabled branch also returns
// 0 so flipping the flag without writing logic cannot corrupt the gate.

describe("BR-21 — SBOP factor (Pattern F stub)", () => {
  it("contributes exactly 0 when sbop_enabled=false", () => {
    const config = makeConfig({ sbopEnabled: false });
    const result = sbopFactor.compute(makeParticipant(), config);
    expect(result.valueNumeric).toBe(0);
    expect(result.valueLabel).toBe("sbop disabled");
  });

  it("contributes 0 when sbop_enabled=true (pending GAP-9 ratification)", () => {
    const config = makeConfig({ sbopEnabled: true });
    const result = sbopFactor.compute(makeParticipant(), config);
    expect(result.valueNumeric).toBe(0);
    expect(result.valueLabel).toContain("GAP-9");
  });

  it("is deterministic across repeated calls (TR-PRIORITY-4)", () => {
    const config = makeConfig({ sbopEnabled: false });
    const participant = makeParticipant();
    const first = sbopFactor.compute(participant, config);
    for (let i = 0; i < 100; i++) {
      const repeat = sbopFactor.compute(participant, config);
      expect(repeat).toEqual(first);
    }
  });

  it("does not read from the participant (purity, Immutable #1)", () => {
    const config = makeConfig({ sbopEnabled: false });
    // Two wildly different participants must produce the same SBOP result
    // while the flag is false.
    const a = sbopFactor.compute(makeParticipant({ failed_attempts: 0 }), config);
    const b = sbopFactor.compute(
      makeParticipant({
        participantId: "0035g00000XYZ",
        failed_attempts: 99,
        recent_incident: true,
      }),
      config,
    );
    expect(a).toEqual(b);
  });
});
