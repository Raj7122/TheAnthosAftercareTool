// Phase 0 calibration dataset — TypeScript mirrors of the on-disk JSON
// contract (schema v1).
//
// These types pair the labeled-dataset files with the consumer side of
// P0-13b's engine-vs-label agreement compute. They intentionally duplicate
// the structural assertions in test/calibration/phase-0-fixtures.test.ts
// so the agreement harness can consume `Phase0LabelSet[]` and
// `Phase0ProfileSet` directly without re-declaring inline.
//
// When the schema is bumped to v2, change the `schema_version` literal and
// fan the loader on the version field — additive changes (new optional
// fields, new factor keys) stay at v1.

import type { SpecialistJudgment } from "./metric.js";

export interface Phase0OpenBarrier {
  readonly type: string;
  readonly severity: "high" | "medium" | "low";
  readonly opened_at: string;
}

export interface Phase0ProfileFactors {
  readonly days_since_last_contact: number | null;
  readonly stability_visit_state:
    | "on_track"
    | "upcoming"
    | "missed"
    | "catchup";
  readonly failed_attempts: number;
  readonly recent_incident: boolean;
  readonly open_barriers: ReadonlyArray<Phase0OpenBarrier>;
  readonly unit_engagement: "stable" | "strained" | "crisis";
  readonly aftercare_extended: boolean;
  readonly voucher_recert_deadline: number | null;
  readonly confirmed_ai_signals: ReadonlyArray<string>;
}

export interface Phase0InvariantTriggers {
  readonly br24_failed_attempts_ge_threshold: boolean;
  // P0-04e: BR-25's data source pivoted from a `Repair pending` Barrier Type
  // to the dedicated `Repair__c` object — the `_barrier` suffix is now a
  // misnomer (it is a repair, not a Barrier). The field name is retained
  // deliberately: it is part of the locked Phase-0 ground-truth JSON contract
  // (schema v1) and the on-disk labelled
  // profile files. Do NOT rename without a coordinated schema v2 bump.
  readonly br25_open_repair_barrier: boolean;
  readonly br26_habitability_barrier: boolean;
}

export interface Phase0Profile {
  readonly profile_id: string;
  readonly narrative_ref: string;
  readonly factors: Phase0ProfileFactors;
  readonly invariant_triggers: Phase0InvariantTriggers;
  readonly notes: string;
}

export interface Phase0ProfileSet {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly spec_refs: ReadonlyArray<string>;
  readonly profiles: ReadonlyArray<Phase0Profile>;
}

export interface Phase0Label {
  readonly profile_id: string;
  readonly specialist_id: string;
  readonly judgment: SpecialistJudgment;
  readonly notes: string;
  readonly transcript_anchor: string;
}

export interface Phase0LabelSet {
  readonly schema_version: 1;
  readonly specialist_id: string;
  readonly session_date: string;
  readonly granola_meeting_id: string;
  readonly granola_url: string;
  readonly engine_output_shown: false;
  readonly labels: ReadonlyArray<Phase0Label>;
}
