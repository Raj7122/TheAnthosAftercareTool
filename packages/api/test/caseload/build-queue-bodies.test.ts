import { getCalibrationConfiguration } from "@anthos/domain";
import { describe, expect, it } from "vitest";

import {
  buildAllQueueBodies,
  compareScored,
} from "../../src/caseload/build-queue-bodies.js";
import {
  dueDatesWith,
  makeEngineOutput,
  makeScored,
  makeSnapshot,
} from "./_fixtures.js";

const SPECIALIST_ID = "0058K00000XYZAbQAO";
const NOW = new Date("2026-05-23T12:00:00Z");
const CONFIG = getCalibrationConfiguration();
const QUEUE_IDS = Object.keys(CONFIG.queuePredicates);
// `caseload_overview` is the BR-20 default; `due_soon` exercises a non-trivial
// predicate so cross-queue counts stay distinct.
const DUE_SOON_DATE = new Date("2026-06-02T12:00:00Z"); // ~10 days out

describe("buildAllQueueBodies", () => {
  it("emits one CaseloadBody per queue in the M-CONFIG universe", () => {
    const scored = [
      makeScored(makeSnapshot("p-1", SPECIALIST_ID), makeEngineOutput("p-1")),
      makeScored(makeSnapshot("p-2", SPECIALIST_ID), makeEngineOutput("p-2")),
    ];
    const { bodies, queueCounts } = buildAllQueueBodies({
      scored,
      configuration: CONFIG,
      specialistId: SPECIALIST_ID,
      configVersion: 1,
      now: NOW,
    });

    expect(bodies.size).toBe(QUEUE_IDS.length);
    for (const id of QUEUE_IDS) {
      const body = bodies.get(id);
      expect(body, `body for ${id}`).toBeDefined();
      expect(body?.queue).toBe(id);
      expect(body?.specialistId).toBe(SPECIALIST_ID);
      expect(body?.sort).toBe("priority_desc");
      expect(body?.cacheAgeSeconds).toBe(0);
      expect(body?.configurationVersion).toBe(1);
      // Every body references the SAME fully-populated counts object — that is
      // the load-bearing invariant the GET cold-path relies on.
      expect(body?.queueCounts).toBe(queueCounts);
    }
  });

  it("computes queueCounts correctly across queues with differing predicates", () => {
    // p-due has a checkpoint 10 days out → member of `due_soon`;
    // p-far has no upcoming → not a `due_soon` member.
    const scored = [
      makeScored(
        makeSnapshot("p-due", SPECIALIST_ID, {
          enrollment: { dueDates: dueDatesWith(DUE_SOON_DATE) },
        }),
        makeEngineOutput("p-due"),
      ),
      makeScored(makeSnapshot("p-far", SPECIALIST_ID), makeEngineOutput("p-far")),
    ];

    const { queueCounts } = buildAllQueueBodies({
      scored,
      configuration: CONFIG,
      specialistId: SPECIALIST_ID,
      configVersion: 1,
      now: NOW,
    });

    expect(queueCounts["caseload_overview"]).toBe(2);
    expect(queueCounts["due_soon"]).toBe(1);
  });

  it("BR-21: sorts within each queue by priority score descending, degraded last", () => {
    const scored = [
      makeScored(
        makeSnapshot("p-low", SPECIALIST_ID),
        makeEngineOutput("p-low", { priorityScore: 30 }),
      ),
      makeScored(makeSnapshot("p-degraded", SPECIALIST_ID), null),
      makeScored(
        makeSnapshot("p-high", SPECIALIST_ID),
        makeEngineOutput("p-high", { priorityScore: 90 }),
      ),
    ];

    const { bodies } = buildAllQueueBodies({
      scored,
      configuration: CONFIG,
      specialistId: SPECIALIST_ID,
      configVersion: 1,
      now: NOW,
    });

    const overview = bodies.get("caseload_overview");
    expect(overview?.items.map((i) => i.participantId)).toEqual([
      "p-high",
      "p-low",
      "p-degraded",
    ]);
  });
});

describe("compareScored", () => {
  it("places degraded participants after non-degraded regardless of score", () => {
    const high = makeScored(
      makeSnapshot("p-high", SPECIALIST_ID),
      makeEngineOutput("p-high", { priorityScore: 90 }),
    );
    const degraded = makeScored(makeSnapshot("p-degraded", SPECIALIST_ID), null);
    expect(compareScored(high, degraded)).toBeLessThan(0);
    expect(compareScored(degraded, high)).toBeGreaterThan(0);
  });

  it("orders two degraded rows deterministically by participantId", () => {
    const a = makeScored(makeSnapshot("p-a", SPECIALIST_ID), null);
    const b = makeScored(makeSnapshot("p-b", SPECIALIST_ID), null);
    expect(compareScored(a, b)).toBe(-1);
    expect(compareScored(b, a)).toBe(1);
    expect(compareScored(a, a)).toBe(0);
  });
});
