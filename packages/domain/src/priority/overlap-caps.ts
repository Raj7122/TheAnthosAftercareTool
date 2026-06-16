import type { FactorWeights } from "../config/index.js";
import type { FactorContribution } from "./types.js";

// BR-22 / TR-PRIORITY-9 — unreachability cap.
//
// When the configuration declares an overlap_caps entry, the engine MUST
// aggregate the listed factors as MAX(pointsContributed), not SUM. This
// prevents the same "we can't reach this person" signal compounding through
// multiple factor channels (e.g. `Cannot reach participant` Barrier and
// failed contact attempts) into Tier 1 by arithmetic coincidence.
//
// Implementation contract:
//   - Pure: no I/O, no mutation of the input contributions array.
//   - The cap is applied at score aggregation only. Individual
//     FactorContribution rows retain their raw `pointsContributed` so the
//     calibration UI and audit consumers see un-collapsed values (BR-12).
//   - Transparency: every cap entry that actually overlaps (2+ listed
//     factors present in contributions) emits a TriggeredOverlapCap so
//     downstream consumers can explain why
//     `priorityScore < sum(factors.pointsContributed)`.
//   - The `cap: number` field on each entry is NOT consumed: BR-22 specifies
//     MAX-of-contributions only. The field remains in the schema for
//     forward-compat; any reshape is out of scope for P0-05.
//   - Cap entries are processed independently in declared order. Multi-cap
//     interaction (same factor in two cap entries) is undefined by spec;
//     Phase 0 has one cap entry (unreachability) and we don't preempt the
//     spec on cross-entry semantics.

export interface TriggeredOverlapCap {
  readonly factors: ReadonlyArray<string>;
  readonly presentFactors: ReadonlyArray<string>;
  readonly winningFactor: string;
  readonly winningPoints: number;
  readonly absorbedPoints: number;
}

export interface OverlapCapResult {
  readonly effectiveScore: number;
  readonly triggeredCaps: ReadonlyArray<TriggeredOverlapCap>;
}

export function applyOverlapCaps(
  contributions: ReadonlyArray<FactorContribution>,
  overlapCaps: FactorWeights["overlap_caps"],
): OverlapCapResult {
  const rawSum = contributions.reduce((acc, c) => acc + c.pointsContributed, 0);

  const byKey = new Map<string, FactorContribution>();
  for (const c of contributions) {
    byKey.set(c.key, c);
  }

  const triggered: TriggeredOverlapCap[] = [];
  let totalAbsorbed = 0;

  for (const entry of overlapCaps) {
    const present: FactorContribution[] = [];
    for (const key of entry.factors) {
      const hit = byKey.get(key);
      if (hit !== undefined) present.push(hit);
    }
    if (present.length < 2) continue;

    let winner = present[0];
    if (winner === undefined) continue;
    for (let i = 1; i < present.length; i++) {
      const candidate = present[i];
      if (candidate === undefined) continue;
      if (
        candidate.pointsContributed > winner.pointsContributed ||
        (candidate.pointsContributed === winner.pointsContributed &&
          candidate.key < winner.key)
      ) {
        winner = candidate;
      }
    }

    const presentSum = present.reduce((s, c) => s + c.pointsContributed, 0);
    const absorbed = presentSum - winner.pointsContributed;
    totalAbsorbed += absorbed;

    triggered.push({
      factors: entry.factors,
      presentFactors: present.map((c) => c.key),
      winningFactor: winner.key,
      winningPoints: winner.pointsContributed,
      absorbedPoints: absorbed,
    });
  }

  return {
    effectiveScore: rawSum - totalAbsorbed,
    triggeredCaps: triggered,
  };
}
