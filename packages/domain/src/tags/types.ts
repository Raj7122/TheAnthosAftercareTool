import type { PerAnchorState } from "../cycle/types.js";

// P1H-03 — caseload row "Barriers / Tags" column inventory.
//
// Tags are a derived PRESENTATION layer. They share source fields with the
// BR-19 priority factors (see snapshot-projection at
// `packages/api/src/calibration/snapshot-projection.ts`) but the derivation
// is intentionally separate so the engine stays pure and the tag set can
// evolve at UI cadence without touching scoring (engine
// invariant: factors drive priority, tags do not).
//
// `severity` is the abstract enum; CSS-variant mapping is the SPA's job
// (P1H-05). The "info" tier covers neutral signals (e.g. `path_c_suppression`)
// where the chip exists to communicate context, not urgency. Aftercare
// Extended was previously the canonical "info" example; P1H-14 moved it to a
// dedicated `ProgramModifierChip` in the PARTICIPANT cell — info-tier tags
// now sit alongside high/med/low signals in the same TAGS cluster, not as
// program-state badges.
export interface RowTag {
  readonly key: string;
  readonly label: string;
  readonly severity: "high" | "med" | "low" | "info";
}

// P1H-10 — Path C SBOP suppression state. Pattern F stub: the shape is in
// place but the data source is BR-21-blocked (GAP-9). Until ratification +
// upstream detection ship, `pathCSuppression` is always `null` at the caller
// (see `packages/api/src/caseload/dto.ts` `buildRowTagSnapshot`); the
// `path_c_suppression` tag derives from `active === true` so the day the
// flag flips and detection lands, no derivation changes — only the data.
//
// `provider` and `reason` are display-only fields for the row treatment; they
// are NEVER permitted in audit metadata or any persisted record outside SF
// (PII firewall + immutable #1).
export interface PathCSuppressionState {
  readonly active: boolean;
  readonly reason: string | null;
  readonly seenAt: Date | null;
  readonly provider: string | null;
}

// Domain-local input shape for `deriveRowTags`. Mirrors the pattern in
// `priority/invariants/open-repair.ts` (RepairInput) and
// `priority/factors/arrears.ts` (ArrearInput): the domain package stays
// integration-free, so the caller (DTO layer at
// `packages/api/src/caseload/dto.ts`) marshals the structured CaseloadSnapshot
// + active Configuration into this flat shape before calling.
//
// Each field is required (no optional) so callers cannot silently omit a
// source; pass `null` / `0` / `[]` to express "no data."
export interface RowTagSnapshot {
  // BR-19(b) source — `Upcoming_Aftercare_Visit_Due_Date__c`. The
  // visit_overdue tag fires when this date is strictly in the past.
  readonly upcomingVisitDueDate: Date | null;

  // BR-19(c) source — failed-attempt rollup
  // (`Num_of_Aftercare_Check_Ins_Attempted__c`). The `cannot_reach` /
  // `failed_attempts` tag pair fires when this meets / exceeds
  // `failedAttemptsThreshold`. Pass 0 when the rollup is null.
  readonly failedAttempts: number;
  // Configurable cutoff (BR-24's `failed_attempts_tier1_threshold`, FS v1.12
  // default 3). Mirrors the BR-24 tier-1 floor so the tag and the floor agree.
  readonly failedAttemptsThreshold: number;

  // BR-19(i) source — days until `Subsidy_Renewal_Re_Cert_Due_Date__c`. Pass
  // `null` when the recert date is missing. The `voucher_critical_<N>d` tag
  // fires when `1 <= days <= voucherRecertWarningDays`; `voucher_critical_overdue`
  // fires when `days <= 0`.
  readonly voucherRecertDays: number | null;
  // Configurable in-window cutoff (BR-19(i) `voucherRecertWarningDays`, FS
  // v1.12 default 30).
  readonly voucherRecertWarningDays: number;

  // F-05 BR-26 Option A — per-anchor breakdown. The `catch_up` tag fires when
  // any anchor's state is `catch_up`. The full anchor field isn't needed —
  // only `state` — but the type is permissive so callers can pass the existing
  // breakdown rows verbatim.
  readonly perCheckpointBreakdown: ReadonlyArray<{ readonly state: PerAnchorState }>;

  // Recent incidents window for the `recent_incident` tag is fixed at 14
  // days per ticket P1H-03 (tighter than BR-19(d)'s 30-day factor window —
  // the tag surfaces only the freshest events). Pass `incidentDate: null` for
  // junction rows missing a date — those are treated as no signal.
  readonly incidents: ReadonlyArray<{ readonly incidentDate: Date | null }>;

  // BR-19(g) source — count of `Arrear__c` rows attached to the PE. The
  // `arrears` tag fires when this is ≥ 1. Pre-counted by the caller so the
  // domain function never sees the raw arrear shape (which carries PII-
  // adjacent free-text fields elsewhere).
  readonly arrearsCount: number;

  // BR-19(h) source — `Aftercare_Extension_End_Date__c` straight off
  // `EnrollmentSnapshot`. P1H-14 retired the `aftercare_extended` tag (moved
  // to `CaseloadItem.aftercareExtended` / `ProgramModifierChip`); the field
  // stays on this shape because future tag rules may still consult the date
  // (e.g., "extension expiring soon" would derive from it).
  readonly aftercareExtensionEndDate: Date | null;

  // P1H-10 — Path C SBOP suppression state. Always `null` today; the caller
  // (`buildRowTagSnapshot` in the DTO layer) does not yet wire a data source.
  // When BR-21 ratifies and the upstream detection ticket lands, the caller
  // populates this; `deriveRowTags` already emits the `path_c_suppression`
  // info chip when `active === true`. Pattern F: one code path, parameterized
  // by data — never a separate stub-vs-production branch in this function.
  readonly pathCSuppression: PathCSuppressionState | null;
}
