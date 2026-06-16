// Wire shapes for E-11 (POST /api/v1/participants/:id/sms) — the F-09 outbound
// SMS façade per API v1.3. Path-as-contract: the verb encodes the SMS channel;
// the recipient phone is resolved server-side from the participant's Contact
// (never accepted from the client — PII firewall + authority).
//
// Quiet hours (Immutable #4) are enforced in the handler, not the schema: a send
// with no `scheduledFor` during the participant's local 9 PM–8 AM window is
// BLOCKED with a typed 409 carrying the next allowed window; the SPA may then
// re-submit with `scheduledFor` set to that instant (under a fresh
// Idempotency-Key, since the body — and thus the request hash — changes).

import { z } from "zod";

// API §E-11 max body length. Mogli segments long messages; 1600 chars ≈ 10
// SMS segments and matches the spec cap.
export const SMS_BODY_MAX_LEN = 1600;

// `templateKey` is non-authoritative provenance metadata (which canned template
// the specialist started from). The API spec enumerates checkin|reminder|
// voucher|custom, but the compose surface owns its own template keys; we accept
// any short token rather than couple the wire to a frontend enum, and record it
// in the audit `payloadMetadata.template_key`. Bounded so it can never carry a
// message body by misuse.
const TEMPLATE_KEY_MAX_LEN = 40;

export const sendSmsRequestSchema = z
  .object({
    body: z
      .string()
      .min(1, "body must not be empty")
      .max(SMS_BODY_MAX_LEN, `body exceeds ${SMS_BODY_MAX_LEN} chars`),
    templateKey: z.string().max(TEMPLATE_KEY_MAX_LEN).optional(),
    // ISO-8601 with offset. When present the send is scheduled (used by the
    // quiet-hours next-window path); the handler validates it is itself outside
    // quiet hours and not in the past.
    scheduledFor: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type SendSmsRequest = z.infer<typeof sendSmsRequestSchema>;

// `priorityRecomputed` mirrors the Log-a-Call / barriers wire shape so the SPA
// reads identical engine output regardless of which mutation surfaced it.
export interface PriorityRecomputedFactor {
  readonly key: string;
  readonly name: string;
  readonly valueLabel: string;
  readonly valueNumeric: number;
  readonly weight: string;
  readonly pointsContributed: number;
}

export interface PriorityRecomputed {
  readonly participantId: string;
  readonly score: number | null;
  readonly tier: number | null;
  readonly factors: ReadonlyArray<PriorityRecomputedFactor>;
  readonly previousScore: number | null;
  readonly previousTier: number | null;
}

export type SmsDeliveryStatus = "queued" | "scheduled";

// E-11 success body (201). `sentAt` is the enqueue instant (server clock);
// `scheduledFor` echoes the requested future delivery time or null.
// `consentVerifiedAt` records when SMS consent was confirmed at send time
// (BR-46) — null is never returned on success (a missing/withdrawn consent is a
// 4xx before the write).
export interface SendSmsResponseBody {
  readonly smsId: string;
  readonly mogliMessageId: string;
  readonly participantId: string;
  readonly sentAt: string;
  readonly deliveryStatus: SmsDeliveryStatus;
  readonly scheduledFor: string | null;
  readonly consentVerifiedAt: string;
  readonly priorityRecomputed: PriorityRecomputed;
}
