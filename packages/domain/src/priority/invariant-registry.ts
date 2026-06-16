import type { Configuration } from "../config/index.js";
import { ConfigValidationError } from "./errors.js";
import {
  createBarrierTypeInvariant,
  createFailedAttemptsInvariant,
  createOpenRepairInvariant,
} from "./invariants/index.js";
import type { TierInvariant } from "./types.js";

// P0-04a — constructs the active TierInvariant set from the configuration's
// `tierInvariants` block (BR-24/25/26, TR-PRIORITY-15/16/17).
//
// BR-24 is always-on whenever the threshold is finite — `failed_attempts`
// is a numeric factor every Phase-0 caseload hydrates, so the floor lights
// up the moment a participant crosses N.
//
// BR-25 (P0-04e) — the open-repair invariant. Pivoted off the Barriers
// picklist onto the dedicated `Repair__c` object (Julia 2026-05-19), so it no
// longer flows through `barrier_type_to_invariant` and has no
// `VR_08_UNKNOWN_BARRIER_TYPE` check — it does not depend on the SF Barrier
// Type picklist enum cache. Constructed when `open_repair_invariant` is
// non-null; dark in Demo Mode (the `null` seed).
//
// BR-26 is a config-ready stub in Demo Mode: the `barrier_type_to_invariant`
// map is empty until Anthos extends the Salesforce Barriers picklist (Q23
// pending Erik). Once populated, every key MUST exist in `knownBarrierTypes`
// (the SF enum cache) or this function throws `VR_08_UNKNOWN_BARRIER_TYPE`.
// The intent (TR-PRIORITY-17) is that invariant-config drift after a picklist
// edit is a deploy-time failure, not a silent regression.
//
// Ordering is load-bearing: `applyTierFloors` preserves the input order in
// `triggeredInvariants` (TR-PRIORITY-4 / BR-17). The set is built in the
// order BR-24, BR-25, then the BR-26 barrier-type entries.
export function getActiveInvariants(
  configuration: Configuration,
  knownBarrierTypes: ReadonlySet<string>,
): ReadonlyArray<TierInvariant> {
  const tierInvariants = configuration.tierInvariants;
  const invariants: TierInvariant[] = [];

  // BR-24 — failed_attempts ≥ failed_attempts_tier1_threshold.
  invariants.push(
    createFailedAttemptsInvariant({
      threshold: tierInvariants.failed_attempts_tier1_threshold,
    }),
  );

  // BR-25 — open-repair invariant (P0-04e). No `knownBarrierTypes` check:
  // BR-25 reads the `Repair__c` object, not the Barrier Type picklist.
  // Constructed only when the config block is present; like the BR-26 stub it
  // is dark in Demo Mode (the block is `null`). Pattern F — even when
  // constructed it fires only once `repairs[]` hydration is projected onto
  // the participant.
  const openRepair = tierInvariants.open_repair_invariant;
  if (openRepair !== null) {
    invariants.push(
      createOpenRepairInvariant({
        invariantId: openRepair.invariant_id,
        displayLabel: openRepair.display_label,
      }),
    );
  }

  // BR-26 — one TierInvariant per configured barrier-type mapping.
  // Iteration order matches `Object.keys()` insertion order, which Node
  // preserves deterministically for string keys.
  for (const [barrierType, entry] of Object.entries(
    tierInvariants.barrier_type_to_invariant,
  )) {
    if (!knownBarrierTypes.has(barrierType)) {
      throw new ConfigValidationError(
        "VR_08_UNKNOWN_BARRIER_TYPE",
        `Tier-invariant mapping references Barrier Type '${barrierType}' which is not present in the Salesforce picklist enum cache. ` +
          `Add the Type to the picklist (and refresh the enum cache) before activating this configuration version, or remove the mapping.`,
        {
          configurationVersion: configuration.version,
          barrierType,
          invariantId: entry.invariant_id,
        },
      );
    }

    invariants.push(
      createBarrierTypeInvariant({
        invariantId: entry.invariant_id,
        barrierType,
        displayLabel: entry.display_label,
      }),
    );
  }

  return invariants;
}
