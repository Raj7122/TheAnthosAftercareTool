// Demo-Mode Barrier severity classifier (FS v1.12 §F-06 BR-37). The hardcoded
// Type → tier table is the canonical [PROPOSED] coarse three-tier classification
// from the spec; calibration validates the numeric weights downstream. The
// Production substrate swaps this for an M-CONFIG-backed
// `barrier_severity_classification` jsonb (ERD §6.7) — the function shape stays
// identical, only the data source moves.
//
// `out_of_scope` collects the four Types whose `Stage That Barrier was
// Identified` is always Screening-and-Assignment (Q4b). These Types cannot
// arrive through this endpoint because the server hard-codes Stage='Aftercare'
// per BR-33; the tier is mapped here only so downstream code never has to
// special-case an unknown Type.
//
// `Repair pending` is no longer a Barrier Type — Q22 resolved it to the
// dedicated `Repair__c` object (FS v1.12 §F-06 v1.13 erratum). `Habitability /
// building condition` is the only BR-37 high-severity entry pending picklist
// extension (Q23 open); it is not in `KNOWN_BARRIER_TYPES` today, so a
// caller passing it gets caught by VR-12 before classification is even called.

export type BarrierSeverity = "high" | "medium" | "low";

// Unioned at the type level so a future caller (e.g. response builder) can
// narrow `out_of_scope` away when the input is guaranteed to be an
// Aftercare-stage Type.
export type BarrierSeverityClassification = BarrierSeverity | "out_of_scope";

const HIGH_SEVERITY: ReadonlySet<string> = new Set([
  "Domestic Violence",
  "Medical/Mental Health Emergency",
  "Personal or medical emergency",
  "Concerning behavior",
  "Cannot reach participant",
]);

const MEDIUM_SEVERITY: ReadonlySet<string> = new Set([
  "Arrears (rent or utilities)",
  "Existing arrears issue",
  "Legal issues",
  "Loss of income (income mod needed)",
  "Landlord disputes",
  "Neighbor disputes",
  "Mobility issue",
  "Transportation issue",
  "Needs childcare",
  "Moved long-term guest into apartment",
  "Legal history",
]);

const LOW_SEVERITY: ReadonlySet<string> = new Set([
  "PA issue",
  "Documentation issue",
  "Financial Literacy Need",
  "Animal without documentation",
  "Bad credit",
  "Work hours",
  "Voucher/shopping letter expired",
]);

// Screening-stage Types — see header. Listed so the function is total over the
// 27 known Types.
const OUT_OF_AFTERCARE_SCOPE: ReadonlySet<string> = new Set([
  "Banked units do not match needs",
  "Banked units do not match preferences",
  "Over income requirements",
  "No show to viewings",
]);

export function classifyBarrierSeverity(
  type: string,
): BarrierSeverityClassification | null {
  if (HIGH_SEVERITY.has(type)) return "high";
  if (MEDIUM_SEVERITY.has(type)) return "medium";
  if (LOW_SEVERITY.has(type)) return "low";
  if (OUT_OF_AFTERCARE_SCOPE.has(type)) return "out_of_scope";
  return null;
}
