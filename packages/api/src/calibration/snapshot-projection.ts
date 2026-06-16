import type { Configuration, HydratedParticipant } from "@anthos/domain";
import type { CaseloadSnapshot } from "@anthos/integrations";

// P0-04f — projects the structured P0-08 CaseloadSnapshot onto the flat
// per-factor input keys the BR-19 priority factors read off HydratedParticipant.
//
// This is the seam P0-04 deferred ("P0-04's mapping-layer job"): each domain
// factor reads one flat key (e.g. participant["stability_visit_state"]); this
// module derives that key from the structured snapshot. It lives in
// packages/api — the only layer that may depend on BOTH @anthos/domain and
// @anthos/integrations — so packages/domain stays integration-free (the
// P0-04e precedent).
//
// Pure: never mutates `snap`. Two factor keys are intentionally NOT projected:
//   - `unit_engagement` — its only source, EnrollmentSnapshot.unitEngagement,
//     is the unresolved Q15 stub; the factor was dropped from the active
//     registry per the 2026-05-20 Q15 Option B retirement.
//   - `sbop` — that factor reads configuration only, no participant input.

const MS_PER_DAY = 86_400_000;

// Whole elapsed days, floored. Negative when `to` precedes `from`.
function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

type Enrollment = CaseloadSnapshot["enrollment"];

// BR-19(a) — whole days since the most recent successful contact. `null`
// (never contacted) is passed through: the factor maps it to the BR-15
// never-contacted sentinel. The factor clamps a negative result to 0.
function deriveDaysSinceLastContact(
  enrollment: Enrollment,
  now: Date,
): number | null {
  const contact = enrollment.mostRecentSuccessfulContact;
  return contact === null ? null : wholeDaysBetween(contact, now);
}

// BR-19(b) — date-only derivation of the stability-visit state.
//
// The CaseloadSnapshot carries NO per-checkpoint Stability-Meeting credit
// data: the SF check-in rollups are lifetime counts, and
// `Upcoming_Aftercare_Visit_Due_Date__c` is a pure calendar formula on
// `Days_in_Aftercare__c` (anthos-demo formula introspection, P0-04f). So only
// the two states ahead of a missed checkpoint are derivable here:
//   - "upcoming": the next checkpoint is within the BR-28 lead-time window
//                 (Configuration.dueStatusLeadTimeDays, default 14).
//   - "on_track": a checkpoint is further out, already in the past, or absent.
// "missed" / "catchup" require knowing whether each checkpoint was credited by
// a Type='Stability Meeting' Case Note — not in the snapshot, and this ticket
// does not change the hydration adapter. They are NOT emitted.
//
// KNOWN LIMITATION (BR-35): because this projection never emits "catchup" or
// "missed", the engine's BR-35 catch-up Tier-1 floor cannot fire from a
// hydrated snapshot — a participant with a genuinely missed checkpoint scores
// 0 on this factor. P0-13b calibration under-weights such participants until
// per-checkpoint credit is hydrated.
//
// SWAP POINT: if a later ticket hydrates per-checkpoint credit, replace this
// function body alone — nothing else in the projection changes.
function deriveStabilityVisitState(
  enrollment: Enrollment,
  configuration: Configuration,
  now: Date,
): "on_track" | "upcoming" {
  const upcoming = enrollment.dueDates.upcoming;
  if (upcoming === null) return "on_track";
  const daysUntil = wholeDaysBetween(now, upcoming);
  if (daysUntil >= 0 && daysUntil <= configuration.dueStatusLeadTimeDays) {
    return "upcoming";
  }
  return "on_track";
}

// BR-19(c) — failed contact attempts.
//
// `checkInsAttempted` is the SF DLRS rollup
// `Num_of_Aftercare_Check_Ins_Attempted__c`, which counts Case Notes with
// Status='Attempted' — exactly the BR-19(c) definition of a failed attempt.
// KNOWN LIMITATION: it is a LIFETIME count; BR-19(c)'s "reset to 0 on
// successful contact" rule is not expressible from a rollup (the per-Case-Note
// query was dropped in P0-08d — IDW_Case_Note__c has no participant link).
// `null` coerces to 0 because the factor throws on a non-number input; a null
// rollup therefore also leaves the BR-24 categorical Tier-1 floor
// (failed_attempts >= failed_attempts_tier1_threshold) unfired for that
// participant — a documented under-count pending full reset fidelity.
function deriveFailedAttempts(enrollment: Enrollment): number {
  const n = enrollment.checkInsAttempted;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

// BR-19(d) — true when any incident falls inside the recent-incident window
// (Configuration.recentIncidentWindowDays, default 30 per FS BR-19(d)). The
// window boundary is inclusive.
function deriveRecentIncident(
  incidents: CaseloadSnapshot["incidents"],
  configuration: Configuration,
  now: Date,
): boolean {
  const cutoff =
    now.getTime() - configuration.recentIncidentWindowDays * MS_PER_DAY;
  return incidents.some(
    (incident) =>
      incident.incidentDate !== null &&
      incident.incidentDate.getTime() >= cutoff,
  );
}

// BR-19(e) — open Barriers identified at the Aftercare stage. "Open" is
// `endDate === null` (Status__c is the SF formula "Open while End_Date__c is
// null"). Severity is resolved inside the factor from
// Configuration.barrierSeverityClassification keyed on `type`. `id` flows
// through so the factor's per-barrier subContributions can carry a recordId
// the calibration UI can deep-link from. `daysSinceLastUpdate` is the
// Salesforce `Days_Since_Last_Update__c` formula (BR-39 staleness multiplier).
function deriveOpenBarriers(
  barriers: CaseloadSnapshot["barriers"],
): ReadonlyArray<{
  readonly id: string;
  readonly type: string | undefined;
  readonly daysSinceLastUpdate: number | null;
}> {
  return barriers
    .filter((barrier) => barrier.endDate === null && barrier.stage === "Aftercare")
    .map((barrier) => ({
      id: barrier.id,
      type: barrier.type ?? undefined,
      daysSinceLastUpdate: barrier.daysSinceLastUpdate,
    }));
}

// BR-19(i) — whole days until the voucher recertification deadline. `null`
// (no deadline) is passed through; the factor surfaces it as "no recert date".
function deriveVoucherRecertDeadline(
  enrollment: Enrollment,
  now: Date,
): number | null {
  const deadline = enrollment.voucherRecertDeadline;
  return deadline === null ? null : wholeDaysBetween(now, deadline);
}

// Projects a hydrated CaseloadSnapshot onto the per-factor HydratedParticipant
// shape computePriority() consumes. `now` is the scoring clock — resolved once
// per calibration-set call so every participant scores against an identical
// instant.
export function projectSnapshot(
  snap: CaseloadSnapshot,
  configuration: Configuration,
  now: Date,
): HydratedParticipant {
  return {
    participantId: snap.participantId,
    hydratedAt: snap.hydratedAt,
    // Kept so tier invariants that read structured sibling collections
    // (BR-25 open-repair — createOpenRepairInvariant, P0-04e) still resolve.
    snapshot: snap,
    days_since_last_contact: deriveDaysSinceLastContact(snap.enrollment, now),
    stability_visit_state: deriveStabilityVisitState(
      snap.enrollment,
      configuration,
      now,
    ),
    failed_attempts: deriveFailedAttempts(snap.enrollment),
    recent_incident: deriveRecentIncident(snap.incidents, configuration, now),
    open_barriers: deriveOpenBarriers(snap.barriers),
    // The arrears factor filters open-status rows itself — pass through.
    arrears: snap.arrears,
    aftercare_extended: snap.enrollment.aftercareExtended,
    voucher_recert_deadline: deriveVoucherRecertDeadline(snap.enrollment, now),
    // `unit_engagement` and `sbop` are intentionally absent — see module header.
  };
}
