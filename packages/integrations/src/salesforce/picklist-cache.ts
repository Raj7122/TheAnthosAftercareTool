// Salesforce Barrier Type picklist enum cache.
//
// Demo Mode: this module exports a hardcoded snapshot of the picklist
// values currently in the Anthos org per Erik Q4a (FS v1.12 §F-06 line 699,
// the canonical list of 27 Barrier Types). The BR-26 categorical Tier 1
// invariant (`Habitability / building condition` per TR-PRIORITY-17)
// deliberately references a Type that is NOT in this snapshot — invariant
// config that maps to a missing Type MUST fail-loud at engine construction
// (`getActiveInvariants()`), which prevents silent regression after a
// picklist change. (BR-25 used to reference a `Repair pending` Type here;
// P0-04e pivoted it onto the dedicated `Repair__c` object, so BR-25 no
// longer depends on this cache.)
//
// Production Mode: this module keeps the same `getKnownBarrierTypes()`
// shape but hydrates from a periodic Salesforce metadata fetch. The
// substrate swap is local to this file — domain code never imports the
// concrete set, only the getter.

const ERIK_Q4A_BARRIER_TYPES: ReadonlyArray<string> = [
  "PA issue",
  "Documentation issue",
  "Existing arrears issue",
  "Banked units do not match needs",
  "Banked units do not match preferences",
  "Personal or medical emergency",
  "Transportation issue",
  "Mobility issue",
  "Needs childcare",
  "Work hours",
  "Over income requirements",
  "Voucher/shopping letter expired",
  "Legal history",
  "Bad credit",
  "Medical/Mental Health Emergency",
  "Domestic Violence",
  "Legal issues",
  "Financial Literacy Need",
  "Loss of income (income mod needed)",
  "Arrears (rent or utilities)",
  "Animal without documentation",
  "Neighbor disputes",
  "Landlord disputes",
  "Moved long-term guest into apartment",
  "Concerning behavior",
  "Cannot reach participant",
  "No show to viewings",
];

export const KNOWN_BARRIER_TYPES: ReadonlySet<string> = new Set<string>(
  ERIK_Q4A_BARRIER_TYPES,
);

export function getKnownBarrierTypes(): ReadonlySet<string> {
  return KNOWN_BARRIER_TYPES;
}

// Ordered view of the Type picklist for UI presentation. The Set is the
// canonical membership check (E-15 validation, BR-37 severity lookup); the
// ordered array preserves the FS v1.12 §F-06 line 699 listing so the Create
// Barrier sheet renders the picker in a stable, spec-anchored order.
export function getKnownBarrierTypesOrdered(): ReadonlyArray<string> {
  return ERIK_Q4A_BARRIER_TYPES;
}
