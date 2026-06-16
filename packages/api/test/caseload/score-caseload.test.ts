import { getCalibrationConfiguration } from "@anthos/domain";
import type { Factor } from "@anthos/domain";
import type { BulkHydrationResult, CaseloadSnapshot } from "@anthos/integrations";
import { describe, expect, it, vi } from "vitest";

import { scoreCaseload } from "../../src/caseload/score-caseload.js";
import { makeSnapshot } from "./_fixtures.js";

const NOW = new Date("2026-05-15T12:00:00Z");

// A fake hydration adapter — returns a fixed snapshot set, no Salesforce call.
function fakeHydrate(
  snapshots: ReadonlyArray<CaseloadSnapshot>,
  roundTrips = 2,
): () => Promise<BulkHydrationResult> {
  return () => Promise.resolve({ snapshots, roundTrips, hydratedAt: NOW });
}

describe("scoreCaseload", () => {
  it("scores each hydrated participant through the priority engine", async () => {
    const result = await scoreCaseload("owner-1", {
      hydrate: fakeHydrate([
        makeSnapshot("p-1", "owner-1"),
        makeSnapshot("p-2", "owner-1"),
      ]),
      now: () => NOW,
    });

    expect(result.scored).toHaveLength(2);
    for (const participant of result.scored) {
      expect(participant.degraded).toBe(false);
      expect(participant.engine).not.toBeNull();
    }
    expect(result.scored.map((p) => p.snapshot.participantId)).toEqual([
      "p-1",
      "p-2",
    ]);
  });

  it("passes roundTrips and hydratedAt through from the hydration adapter", async () => {
    const result = await scoreCaseload("owner-1", {
      hydrate: fakeHydrate([makeSnapshot("p-1", "owner-1")], 2),
      now: () => NOW,
    });
    expect(result.roundTrips).toBe(2);
    expect(result.hydratedAt).toEqual(NOW);
  });

  it("degrades every participant when the factor registry is empty", async () => {
    const result = await scoreCaseload("owner-1", {
      hydrate: fakeHydrate([
        makeSnapshot("p-1", "owner-1"),
        makeSnapshot("p-2", "owner-1"),
      ]),
      factors: [],
      now: () => NOW,
    });

    expect(result.scored).toHaveLength(2);
    for (const participant of result.scored) {
      expect(participant.degraded).toBe(true);
      expect(participant.engine).toBeNull();
    }
  });

  it("degrades only the participant whose factor throws, scoring the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A factor keyed to a real BR-19 factor (so assertConfigValid passes) that
    // throws for one participant only.
    const throwingFactor: Factor = {
      key: "days_since_last_contact",
      displayName: "Days since last successful contact",
      type: "numeric",
      compute: (participant) => {
        if (participant.participantId === "p-bad") {
          throw new Error("days_since_last_contact: synthetic factor failure");
        }
        return { valueLabel: "ok", valueNumeric: 1 };
      },
    };

    const result = await scoreCaseload("owner-1", {
      hydrate: fakeHydrate([
        makeSnapshot("p-ok-1", "owner-1"),
        makeSnapshot("p-bad", "owner-1"),
        makeSnapshot("p-ok-2", "owner-1"),
      ]),
      factors: [throwingFactor],
      invariants: [],
      now: () => NOW,
    });

    const byId = new Map(
      result.scored.map((p) => [p.snapshot.participantId, p]),
    );
    expect(byId.get("p-bad")?.degraded).toBe(true);
    expect(byId.get("p-bad")?.engine).toBeNull();
    expect(byId.get("p-ok-1")?.degraded).toBe(false);
    expect(byId.get("p-ok-1")?.engine).not.toBeNull();
    expect(byId.get("p-ok-2")?.degraded).toBe(false);
    warn.mockRestore();
  });

  it("echoes the configuration and scoring clock used", async () => {
    const configuration = getCalibrationConfiguration();
    const result = await scoreCaseload("owner-1", {
      hydrate: fakeHydrate([]),
      configuration,
      now: () => NOW,
    });
    expect(result.configuration).toBe(configuration);
    expect(result.now).toEqual(NOW);
  });
});
