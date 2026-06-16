import type { RowTag, RowTagSnapshot } from "./types.js";

// P1H-03 — derive caseload-row "Barriers / Tags" chips from a snapshot.
//
// Pure. The function emits at most one row per tag-key family in a stable
// ordering — high severity first, then med / low / info — so the SPA can
// render the cluster left-to-right without sorting.
//
// `documentation` is reserved but not yet emitted (ticket P1H-03 §Scope:
// "skip emitting until source confirmed").
//
// `path_c_suppression` (P1H-10) emits when `snapshot.pathCSuppression?.active`
// is true. Pattern F discipline: the caller (`buildRowTagSnapshot`) passes
// `null` until BR-21 ratifies and the upstream detection ticket ships, so
// today the chip never lights — but the production code path is in place,
// and ratification adds no derivation work, only data.
//
// Tag-family contract:
//   - `visit_overdue` (high) — `upcomingVisitDueDate < now`.
//   - `cannot_reach` (high) — `failedAttempts >= failedAttemptsThreshold`.
//     Paired with `failed_attempts` (low) at the same threshold; the wireframe
//     row 2 shows both chips together so the high-severity headline doesn't
//     stand alone.
//   - `voucher_critical_<N>d` (high) — voucher recert in `[1, warningDays]`
//     days. Key carries the day count so the SPA can prefix-match the family
//     and read `N` for label rendering. The degenerate past-due case emits
//     `voucher_critical_overdue` instead of `voucher_critical_-3d` — negative
//     N in a key is a lint trap, and the factor side already calls this
//     condition out as "likely stale" (see
//     `priority/factors/voucher-recert-deadline.ts`).
//   - `catch_up` (med) — any `perCheckpointBreakdown[].state === "catch_up"`.
//   - `recent_incident` (med) — any incident within 14 days of `now`. Window
//     is tighter than BR-19(d)'s 30-day factor window by design (the chip
//     surfaces only the freshest events; calibration still scores the longer
//     factor window).
//   - `arrears` (med) — `arrearsCount >= 1`.
//   - `path_c_suppression` (info) — `pathCSuppression?.active === true`.
//
// P1H-14 moved the Aftercare Extended modifier out of the TAGS cluster and
// into a dedicated `ProgramModifierChip` rendered inline with `displayName`
// in the PARTICIPANT cell. The boolean lives on `CaseloadItem.aftercareExtended`;
// `RowTagSnapshot.aftercareExtensionEndDate` stays on the input shape because
// future tag rules may still consult the date (e.g., "extension expiring soon").
//
// The function never throws on missing inputs — every field has a documented
// "no signal" representation in `RowTagSnapshot`. A degraded row passes
// already-zeroed inputs and naturally derives `[]`.

const RECENT_INCIDENT_TAG_WINDOW_DAYS = 14;
const MS_PER_DAY = 86_400_000;

// Severity ordering used by the stable sort below. High first, then med,
// then low, then info — matches the wireframe's left-to-right chip cluster
// (high-severity badges sit leftmost on every row in scenario 1).
const SEVERITY_ORDER: Record<RowTag["severity"], number> = {
  high: 0,
  med: 1,
  low: 2,
  info: 3,
};

export function deriveRowTags(
  snapshot: RowTagSnapshot,
  now: Date,
): ReadonlyArray<RowTag> {
  const tags: RowTag[] = [];

  // visit_overdue — high. Strict past, so today's date does not fire.
  if (
    snapshot.upcomingVisitDueDate !== null &&
    snapshot.upcomingVisitDueDate.getTime() < now.getTime()
  ) {
    tags.push({
      key: "visit_overdue",
      label: "Visit overdue",
      severity: "high",
    });
  }

  // cannot_reach + failed_attempts — paired at the same threshold. The high-
  // severity chip is the headline; the low-severity chip is the supporting
  // detail (wireframe scenario 1 row 2).
  if (snapshot.failedAttempts >= snapshot.failedAttemptsThreshold) {
    tags.push({
      key: "cannot_reach",
      label: "Cannot reach",
      severity: "high",
    });
    tags.push({
      key: "failed_attempts",
      label: "Failed attempts",
      severity: "low",
    });
  }

  // voucher_critical_<N>d — high. Two label forms; the key carries the day
  // count for in-window cases so the SPA can distinguish 9d vs 23d visual
  // variants without re-deriving from another field.
  if (snapshot.voucherRecertDays !== null) {
    const days = snapshot.voucherRecertDays;
    if (days <= 0) {
      tags.push({
        key: "voucher_critical_overdue",
        label: "Voucher overdue",
        severity: "high",
      });
    } else if (days <= snapshot.voucherRecertWarningDays) {
      tags.push({
        key: `voucher_critical_${days}d`,
        label: `Voucher ${days}d`,
        severity: "high",
      });
    }
  }

  // catch_up — med. Any anchor in catch_up state fires the chip; the F-07
  // detail page is where individual anchor states are inspected.
  if (snapshot.perCheckpointBreakdown.some((row) => row.state === "catch_up")) {
    tags.push({
      key: "catch_up",
      label: "Catch-up",
      severity: "med",
    });
  }

  // recent_incident — med. Strict-inclusive window: an incident dated exactly
  // 14 days before `now` still fires (matches the factor convention).
  const incidentCutoff = now.getTime() - RECENT_INCIDENT_TAG_WINDOW_DAYS * MS_PER_DAY;
  if (
    snapshot.incidents.some(
      (incident) =>
        incident.incidentDate !== null &&
        incident.incidentDate.getTime() >= incidentCutoff,
    )
  ) {
    tags.push({
      key: "recent_incident",
      label: "Recent incident",
      severity: "med",
    });
  }

  // arrears — med. Existence-only signal; the per-arrear status/recency logic
  // is the engine's BR-19(g) factor (see `priority/factors/arrears.ts`).
  if (snapshot.arrearsCount >= 1) {
    tags.push({
      key: "arrears",
      label: "Arrears",
      severity: "med",
    });
  }

  // path_c_suppression — info. P1H-10. Today `pathCSuppression` is always
  // null at the caller (DTO layer; BR-21 GAP-9), so this branch never fires.
  // The branch lands in production code so the day ratification + upstream
  // detection ship, only the data source flips.
  if (snapshot.pathCSuppression?.active === true) {
    tags.push({
      key: "path_c_suppression",
      label: "Path C suppression",
      severity: "info",
    });
  }

  // Stable severity sort (high → info). Within a severity bucket, insertion
  // order is preserved by `Array.prototype.sort` (ES2019).
  tags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return tags;
}
