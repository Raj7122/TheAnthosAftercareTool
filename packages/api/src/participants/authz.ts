// VR-15 authz gate shared by the participant-scoped read endpoints (E-08
// detail and E-09 case-notes history). One source of truth so the two handlers
// cannot drift on caseload-scope semantics.
//
// SPECIALIST → own caseload only (Aftercare_Owner__c must equal the caller).
// VP         → any participant.
// SUPERVISOR → 403 stub until the supervisor→supervised-set mapping lands
//              (same posture as `handleCreateBarrier` and P1F-01's E-08).
// SYSTEM_ADMIN → never permitted on F-07 participant reads.

import type { Role } from "@anthos/auth";

import type { ParticipantIdentity } from "./identity-hydration.js";
import {
  notInOwnCaseloadResponse,
  roleInsufficientScopeResponse,
} from "./responses.js";

// Returns the response factory to invoke on denial, or `null` to admit. The
// factory takes `traceId` so the call site can pass its own trace context.
export function checkAuthz(
  role: Role,
  callerSpecialistId: string,
  identity: ParticipantIdentity,
): ((traceId: string) => Response) | null {
  if (role === "SPECIALIST") {
    if (
      identity.aftercareOwnerId === null ||
      identity.aftercareOwnerId !== callerSpecialistId
    ) {
      return notInOwnCaseloadResponse;
    }
    return null;
  }
  if (role === "VP") return null;
  if (role === "SUPERVISOR") {
    return (traceId) =>
      roleInsufficientScopeResponse(traceId, "supervisor_scope_unmapped");
  }
  return (traceId) =>
    roleInsufficientScopeResponse(traceId, "role_not_permitted");
}
