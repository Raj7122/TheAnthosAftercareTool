// Shared input/output types for the Add Repair sheet + its optimistic surfaces.
// NET-NEW / off-spec (demo-driven), mirroring the barrier sheet's type module so
// the sheet stays surface-agnostic — the caseload "+" and the participant-
// profile RepairsPanel both call into a hook with the same shape.

export interface CreateRepairInput {
  readonly note: string;
}

// A repair logged this session, surfaced optimistically (on the caseload
// calendar and the participant timeline). Like OptimisticSend, this is a "via
// tool" client record — the authoritative row is the Repair__c the BFF wrote.
// Reset on reload; never persisted.
export interface OptimisticRepair {
  readonly repairId: string;
  readonly participantId: string;
  // The participant's display name, captured at create time so a caseload-wide
  // calendar event can label + deep-link the repair. Null when unknown.
  readonly participantName: string | null;
  // UTC YYYY-MM-DD the repair was logged (Identification_Date__c = today).
  readonly identificationDate: string;
  readonly note: string;
  // ISO 8601 instant the BFF stamped (loggedAt).
  readonly loggedAt: string;
}

export type { MutationFailure } from "../../caseload/_lib/send-mutation";
