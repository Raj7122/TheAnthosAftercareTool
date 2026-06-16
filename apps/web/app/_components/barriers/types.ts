// Shared input/output types for the F-06 create/close-Barrier sheets. Both
// the caseload-row hook (`apps/web/app/caseload/_lib/useCaseloadMutations.ts`)
// and the participant-detail hook
// (`apps/web/app/participants/[id]/_lib/useParticipantBarrierMutations.ts`)
// import these and expose them to the sheets so the sheets stay
// surface-agnostic — they call back into either hook with the same shape.

export interface CreateBarrierInput {
  readonly type: string;
  readonly description?: string;
}

export interface CloseBarrierInput {
  readonly barrierId: string;
  readonly closureReason?: string;
}

export type { MutationFailure } from "../../caseload/_lib/send-mutation";
