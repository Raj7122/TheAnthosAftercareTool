// Wire shapes for POST /api/v1/participants/:id/repairs — the M-SF create-
// Repair mutation. NOTE (governance): repairs are NET-NEW / off-spec — the
// authoritative specs (FS/TRD/ERD/API) cover only `Barriers__c` (F-06); there
// is no F-*, E-*, or ERD entity for `Repair__c`. This endpoint is demo-driven
// and intentionally mirrors the E-15 create-Barrier contract shape.
//
// The form is minimal: a single free-text `note` that always routes to the
// repair's `Description__c` long-text field. `Status__c` and
// `Identification_Date__c` are server-set (the client cannot back-date or set an
// arbitrary status), so they are not accepted from the client. Strict object —
// unknown keys yield a 422 VALIDATION_FAILED.

import { z } from "zod";

export const createRepairRequestSchema = z
  .object({
    note: z
      .string({ required_error: "note is required" })
      .min(1, "note is required")
      .max(32000),
  })
  .strict();

export type CreateRepairRequest = z.infer<typeof createRepairRequestSchema>;

// Success body. `note` is echoed back so the SPA can render the optimistic
// timeline row without a re-read (Repair__c has 0 rows in the sandbox and no
// direct PE FK — see create-repair.ts). It is response-only and NEVER enters
// audit metadata. `unitRentalId` is the resolved Unit Engagement the repair was
// attached to (the two-hop participant link).
export interface CreateRepairResponseBody {
  readonly repairId: string;
  readonly participantId: string;
  readonly unitRentalId: string;
  readonly status: "Need Identified";
  readonly identificationDate: string;
  readonly note: string;
  readonly loggedAt: string;
  readonly loggedBy: string;
}
