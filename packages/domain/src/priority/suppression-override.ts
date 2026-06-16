import type {
  SuppressionOverride,
  SuppressionState,
  TriggeredInvariant,
} from "./types.js";

// TR-PRIORITY-18 — when one or more categorical Tier-1 invariants
// (BR-24/25/26) fire for a participant who is currently in BR-21 Path C
// "Snoozed" suppression, the invariant overrides the suppression by default
// (TRD v1.8 §451 / §1782). Suppression auto-clears; downstream BFF authors a
// `Type='System Note'` Case Note with `system_note_reason='invariant_override_suppression'`
// (deferred to follow-up ticket — Salesforce Case Note write adapter does
// not yet exist).
//
// Override direction is M-CONFIG-controlled. When
// `invariant_override_suppression` is `false`, the suppression holds even
// when invariants fire — the engine still floors the tier (invariant tier
// floors are unconditional, see apply-tier-floors.ts), but no override
// payload is emitted and no System Note authoring is triggered. Calibration
// (P0-13b / P0-14) may flip this if specialist judgment argues the reverse.
//
// Pure function — no I/O, no side effects (TR-PRIORITY-1, Immutable #1).
export function decideSuppressionOverride(args: {
  readonly triggeredInvariants: ReadonlyArray<TriggeredInvariant>;
  readonly suppression: SuppressionState | undefined;
  readonly invariantOverrideSuppression: boolean;
}): SuppressionOverride | null {
  if (args.triggeredInvariants.length === 0) return null;
  if (args.suppression?.state !== "snoozed") return null;
  if (!args.invariantOverrideSuppression) return null;

  return {
    reason: "invariant_override_suppression",
    invariantIds: args.triggeredInvariants.map((t) => t.invariantId),
  };
}
