// Shared queue-bodies assembly for the caseload endpoints (P1C-01 GET +
// P1G-01 POST /refresh). Given the scored caseload and the M-CONFIG queue
// universe, produces one PII-free `CaseloadBody` per queue plus the cross-queue
// `queueCounts` map. Both bodies and counts are derived purely — no I/O — so
// this is safe to call inside a DB transaction.
//
// Two consumers share this so the GET cold-path and the POST /refresh path
// can never drift on queue membership, within-queue sort (BR-21), or the
// shape that gets written to `caseload_cache` (P1C-02).

import {
  compareTieBreak,
  evaluateQueuePredicate,
  type Configuration,
} from "@anthos/domain";

import {
  buildCaseloadBody,
  buildCaseloadItem,
  type CaseloadBody,
} from "./dto.js";
import { deriveMembershipInput } from "./queue.js";
import type { ScoredParticipant } from "./score-caseload.js";

export interface BuildAllQueueBodiesInput {
  readonly scored: ReadonlyArray<ScoredParticipant>;
  readonly configuration: Configuration;
  readonly specialistId: string;
  readonly configVersion: number;
  readonly now: Date;
}

export interface BuildAllQueueBodiesResult {
  readonly bodies: Map<string, CaseloadBody>;
  readonly queueCounts: Record<string, number>;
}

// Builds one `CaseloadBody` per queue in the universe. Every body's
// `queueCounts` field aliases the SAME map object that's populated across the
// loop, so by the end of the function every stored body carries the complete
// counts — a small but load-bearing invariant the GET cold-path relied on.
//
// `cacheAgeSeconds: 0` on every body — a freshly-built body is, by definition,
// not from the cache. The GET warm-path computes a real age before serving;
// the cold-path's audit + cache write-through both use this freshly-built shape
// and the refresh endpoint always returns 0 per E-07 §7.3.2.
export function buildAllQueueBodies(
  input: BuildAllQueueBodiesInput,
): BuildAllQueueBodiesResult {
  const { scored, configuration, specialistId, configVersion, now } = input;

  // Membership input per participant — derived once, evaluated against every
  // queue in the universe so `queueCounts` covers all queues.
  const membership = scored.map((participant) => ({
    participant,
    input: deriveMembershipInput(participant.snapshot, now),
  }));

  const queueCounts: Record<string, number> = {};
  const bodies = new Map<string, CaseloadBody>();
  for (const [id, entry] of Object.entries(configuration.queuePredicates)) {
    const members = membership
      .filter((row) => evaluateQueuePredicate(entry.predicate, row.input, now))
      .map((row) => row.participant);
    queueCounts[id] = members.length;
    // BR-21 — within-queue order is priority score descending; degraded rows
    // (no engine output) sort last.
    const items = [...members]
      .sort(compareScored)
      .map((participant) => buildCaseloadItem(participant, configuration, now));
    bodies.set(
      id,
      buildCaseloadBody({
        specialistId,
        queueId: id,
        queueCounts,
        cacheAgeSeconds: 0,
        configurationVersion: configVersion,
        items,
      }),
    );
  }

  return { bodies, queueCounts };
}

// BR-21 within-queue comparator: priority score descending, degraded rows
// last, ties broken by TR-PRIORITY-13 (`compareTieBreak`). Exported so tests
// can pin the ordering invariant directly.
export function compareScored(a: ScoredParticipant, b: ScoredParticipant): number {
  if (a.degraded !== b.degraded) {
    return a.degraded ? 1 : -1;
  }
  if (a.engine !== null && b.engine !== null) {
    if (a.engine.priorityScore !== b.engine.priorityScore) {
      return b.engine.priorityScore - a.engine.priorityScore;
    }
    return compareTieBreak(
      {
        participantId: a.snapshot.participantId,
        mostRecentSuccessfulContactAt: a.snapshot.enrollment
          .mostRecentSuccessfulContact,
      },
      {
        participantId: b.snapshot.participantId,
        mostRecentSuccessfulContactAt: b.snapshot.enrollment
          .mostRecentSuccessfulContact,
      },
    );
  }
  // Both degraded — deterministic order by participant id.
  if (a.snapshot.participantId < b.snapshot.participantId) return -1;
  if (a.snapshot.participantId > b.snapshot.participantId) return 1;
  return 0;
}
