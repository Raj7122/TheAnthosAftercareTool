// Queue resolution + membership derivation for the caseload endpoint (P1C-01,
// F-04). Two concerns, both queue-shaped:
//
//   1. `resolveQueue` — map the `?queue=` request param (or its absence) to a
//      queue entry in the M-CONFIG universe (BR-22). Absent → BR-20 default;
//      unknown id → 404 (the queue universe is config-driven and can drift —
//      P1C-05 tuning is a config change, not a deploy).
//   2. `deriveMembershipInput` — project a hydrated `CaseloadSnapshot` onto the
//      flat `QueueMembershipInput` the pure `evaluateQueuePredicate`
//      (`@anthos/domain`) consumes. This is the api-layer seam that keeps the
//      domain integration-free: the domain never sees a `CaseloadSnapshot`.

import type { QueueEntry, QueueMembershipInput, QueuePredicates } from "@anthos/domain";
import type { CaseloadSnapshot } from "@anthos/integrations";

import { wholeDaysBetween } from "./dates.js";

// The requested `?queue=` id is not a key in the M-CONFIG queue universe.
// The handler maps this to a 404 — an unknown queue is a client error, and
// the universe drifts as P1C-05 tunes it, so it is not a 500.
export class UnknownQueueError extends Error {
  readonly queueId: string;
  constructor(queueId: string) {
    super(`unknown queue id: ${queueId}`);
    this.name = "UnknownQueueError";
    this.queueId = queueId;
  }
}

// The M-CONFIG queue universe is misconfigured (empty, or — defensively — no
// default). `queuePredicatesSchema`'s exactly-one-default refinement makes a
// non-empty universe always resolvable, so this only fires on the empty
// universe; the handler maps it to a 500 (fail-loud, not a client error).
export class QueueConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueConfigurationError";
  }
}

export interface ResolvedQueue {
  readonly queueId: string;
  readonly entry: QueueEntry;
}

// Resolves the `?queue=` param against the M-CONFIG queue universe.
//   - `queueParam === null` (absent)  → BR-20 default (the `isDefault` entry).
//   - known id                        → that entry.
//   - unknown id                      → `UnknownQueueError` (→ 404).
export function resolveQueue(
  queueParam: string | null,
  universe: QueuePredicates,
): ResolvedQueue {
  if (queueParam === null) {
    // BR-20 — the default landing queue. `queuePredicatesSchema` guarantees a
    // non-empty universe declares exactly one `isDefault: true` entry.
    for (const [queueId, entry] of Object.entries(universe)) {
      if (entry.isDefault) {
        return { queueId, entry };
      }
    }
    throw new QueueConfigurationError(
      "queue universe declares no default queue (BR-20)",
    );
  }

  const entry = universe[queueParam];
  if (entry === undefined) {
    throw new UnknownQueueError(queueParam);
  }
  return { queueId: queueParam, entry };
}

// Projects a hydrated snapshot onto the flat `QueueMembershipInput`.
//
// `daysUntilNextCheckIn` / `nextCheckInDate`: `EnrollmentSnapshot` carries no
// dedicated "next monthly check-in" date — the stability-checkpoint formula
// (`dueDates.upcoming`) is the only forward-looking date hydrated, so it is
// used as the proxy (limitation flagged in the PR, parallel to
// `snapshot-projection.ts`'s stability-state limitation).
export function deriveMembershipInput(
  snapshot: CaseloadSnapshot,
  now: Date,
): QueueMembershipInput {
  const enr = snapshot.enrollment;
  const contact = enr.mostRecentSuccessfulContact;
  const upcoming = enr.dueDates.upcoming;
  return {
    daysSinceLastSuccessfulContact:
      contact === null ? null : wholeDaysBetween(contact, now),
    hasEverBeenSuccessfullyContacted: contact !== null,
    // BR-19(c) failed attempts — the `checkInsAttempted` rollup; a null rollup
    // coerces to 0 (mirrors `snapshot-projection.ts deriveFailedAttempts`).
    failedAttempts:
      typeof enr.checkInsAttempted === "number" &&
      Number.isFinite(enr.checkInsAttempted)
        ? enr.checkInsAttempted
        : 0,
    daysUntilNextCheckIn:
      upcoming === null ? null : wholeDaysBetween(now, upcoming),
    nextCheckInDate: upcoming,
  };
}
