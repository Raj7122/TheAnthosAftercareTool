import { getCalibrationConfiguration } from "@anthos/domain";
import { describe, expect, it } from "vitest";

import {
  deriveMembershipInput,
  QueueConfigurationError,
  resolveQueue,
  UnknownQueueError,
} from "../../src/caseload/queue.js";
import { dueDatesWith, makeSnapshot } from "./_fixtures.js";

const QUEUES = getCalibrationConfiguration().queuePredicates;
const NOW = new Date("2026-05-15T12:00:00Z");

// ── resolveQueue (BR-20 default / unknown → 404) ────────────────────────────

describe("resolveQueue", () => {
  it("returns the isDefault queue when ?queue= is absent (BR-20)", () => {
    const { queueId, entry } = resolveQueue(null, QUEUES);
    expect(queueId).toBe("check_ins_due_this_month");
    expect(entry.isDefault).toBe(true);
  });

  it("returns the named queue when ?queue= matches a known id", () => {
    const { queueId, entry } = resolveQueue("due_soon", QUEUES);
    expect(queueId).toBe("due_soon");
    expect(entry.predicate.kind).toBe("due_within_days");
  });

  it("throws UnknownQueueError for an unknown queue id (→ 404)", () => {
    expect(() => resolveQueue("not-a-queue", QUEUES)).toThrow(UnknownQueueError);
    try {
      resolveQueue("not-a-queue", QUEUES);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownQueueError);
      expect((err as UnknownQueueError).queueId).toBe("not-a-queue");
    }
  });

  it("throws QueueConfigurationError when an empty universe has no default", () => {
    expect(() => resolveQueue(null, {})).toThrow(QueueConfigurationError);
  });
});

// ── deriveMembershipInput (snapshot → flat QueueMembershipInput) ─────────────

describe("deriveMembershipInput", () => {
  it("maps a never-contacted participant to null days / hasEver=false", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { mostRecentSuccessfulContact: null, checkInsAttempted: 3 },
    });
    const input = deriveMembershipInput(snap, NOW);
    expect(input.daysSinceLastSuccessfulContact).toBeNull();
    expect(input.hasEverBeenSuccessfullyContacted).toBe(false);
    expect(input.failedAttempts).toBe(3);
  });

  it("maps a contacted participant to whole days since contact", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        mostRecentSuccessfulContact: new Date("2026-05-05T12:00:00Z"),
      },
    });
    const input = deriveMembershipInput(snap, NOW);
    expect(input.daysSinceLastSuccessfulContact).toBe(10);
    expect(input.hasEverBeenSuccessfullyContacted).toBe(true);
  });

  it("coerces a null checkInsAttempted rollup to 0 failed attempts", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { checkInsAttempted: null },
    });
    expect(deriveMembershipInput(snap, NOW).failedAttempts).toBe(0);
  });

  it("derives days-until / next-check-in date from dueDates.upcoming", () => {
    const upcoming = new Date("2026-05-25T12:00:00Z");
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { dueDates: dueDatesWith(upcoming) },
    });
    const input = deriveMembershipInput(snap, NOW);
    expect(input.daysUntilNextCheckIn).toBe(10);
    expect(input.nextCheckInDate).toEqual(upcoming);
  });

  it("maps an absent upcoming date to null days-until / null date", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { dueDates: dueDatesWith(null) },
    });
    const input = deriveMembershipInput(snap, NOW);
    expect(input.daysUntilNextCheckIn).toBeNull();
    expect(input.nextCheckInDate).toBeNull();
  });
});
