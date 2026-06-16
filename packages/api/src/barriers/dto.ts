// Wire shapes for E-15 (POST /api/v1/participants/:id/barriers) per API v1.3
// §7.4.8. The request schema honors FS v1.12 §F-06 / VR-12 / VR-14: `type` is
// required and must be one of the Salesforce-defined Barrier Types (cached in
// `@anthos/integrations` `KNOWN_BARRIER_TYPES`). `description` is optional
// (max 2000 chars per API §7.4.8); `severity` is optional and accepts the
// client's override of the BR-37 classification when supplied.
//
// `openDate` is intentionally NOT accepted from the client: per the ticket
// §Scope, Start Date is server-set to today so a specialist cannot back-date a
// Barrier through this endpoint. The contract row exists in the API spec for
// schema parity with other E-* mutations; this implementation rejects any
// client `openDate` field via Zod `.strict()`.

import { z } from "zod";

const SEVERITY_VALUES = ["high", "medium", "low"] as const;
export type BarrierSeverityInput = (typeof SEVERITY_VALUES)[number];

// Strict object — unknown keys (incl. a forbidden `openDate`) yield a 422
// VALIDATION_FAILED with the offending key path on the error.
export const createBarrierRequestSchema = z
  .object({
    type: z
      .string({ required_error: "type is required" })
      .min(1, "type is required")
      .max(255),
    description: z.string().max(2000).optional(),
    severity: z.enum(SEVERITY_VALUES).optional(),
  })
  .strict();

export type CreateBarrierRequest = z.infer<typeof createBarrierRequestSchema>;

// One row of the per-factor breakdown returned in `priorityRecomputed`. Mirrors
// the wire shape used by E-09 (logCall, API §7.4.3) so the SPA can reconcile
// the same engine output regardless of which mutation surfaced the recompute.
export interface PriorityRecomputedFactor {
  readonly key: string;
  readonly name: string;
  readonly valueLabel: string;
  readonly valueNumeric: number;
  readonly weight: string;
  readonly pointsContributed: number;
}

// Subset of EngineOutput surfaced on the response. `previousScore` /
// `previousTier` are null because this endpoint does not snapshot the pre-write
// state inline — the prior value lives on the caseload cache row P1C-02 will
// populate. The shape stays compatible so the SPA can read the field once both
// tickets land.
export interface PriorityRecomputed {
  readonly participantId: string;
  readonly score: number | null;
  readonly tier: number | null;
  readonly factors: ReadonlyArray<PriorityRecomputedFactor>;
  readonly previousScore: number | null;
  readonly previousTier: number | null;
}

// E-15 success body per API §7.4.8.
export interface CreateBarrierResponseBody {
  readonly barrierId: string;
  readonly participantId: string;
  readonly type: string;
  readonly description: string | null;
  readonly severity: BarrierSeverityInput | null;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly status: "open";
  readonly priorityRecomputed: PriorityRecomputed;
}

// Wire shape for E-16 (PATCH /api/v1/participants/:id/barriers/:barrierId)
// per API v1.3 §7.4.9. The `action` discriminator is mandatory and currently
// admits only `"close"` — reopen is out of scope at v1 (API §7.4 notes). The
// optional `closureReason` is echoed back in the response but never lands in
// audit metadata (free-text PII risk) or Salesforce (no `Closure_Reason__c`
// field on `Barriers__c`).
//
// Strict object — unknown keys yield 422 VALIDATION_FAILED with the offending
// key path; an `action: "reopen"` value yields the same 422 with a discriminator
// reason.
export const closeBarrierRequestSchema = z
  .object({
    action: z.literal("close"),
    closureReason: z.string().max(500).optional(),
  })
  .strict();

export type CloseBarrierRequest = z.infer<typeof closeBarrierRequestSchema>;

// E-16 success body per API §7.4.9. `closureReason` echoes the request value
// (null when omitted) — there is no Salesforce-side persistence for it, so a
// future re-read of the Barrier cannot reconstruct it.
export interface CloseBarrierResponseBody {
  readonly barrierId: string;
  readonly participantId: string;
  readonly status: "closed";
  readonly closedAt: string;
  readonly closedBy: string;
  readonly closureReason: string | null;
  readonly priorityRecomputed: PriorityRecomputed;
}
