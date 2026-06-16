// Wire shapes for E-12 (POST /api/v1/participants/:id/emails) — the F-10
// outbound-email façade per API v1.3. Email is Salesforce-native: the BFF
// invokes a tool-owned autolaunched Flow (TRD v1.9 §) which performs the send
// and creates the Activity / EmailMessage record. No quiet-hours constraint
// applies to email (Immutable #4 is SMS/participant-channel-scoped; email is
// treated as non-quiet-hours per FS v1.12 §F-10).

import { z } from "zod";

// API §E-12 caps.
export const EMAIL_SUBJECT_MAX_LEN = 200;
export const EMAIL_BODY_MAX_LEN = 50_000; // 50KB HTML
const TEMPLATE_KEY_MAX_LEN = 40;

export const sendEmailRequestSchema = z
  .object({
    subject: z
      .string()
      .min(1, "subject must not be empty")
      .max(EMAIL_SUBJECT_MAX_LEN, `subject exceeds ${EMAIL_SUBJECT_MAX_LEN} chars`),
    body: z
      .string()
      .min(1, "body must not be empty")
      .max(EMAIL_BODY_MAX_LEN, `body exceeds ${EMAIL_BODY_MAX_LEN} chars`),
    templateKey: z.string().max(TEMPLATE_KEY_MAX_LEN).optional(),
  })
  .strict();

export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

// The Activity is created synchronously by the Flow, but Salesforce performs
// the actual send asynchronously; "reconciled" means the tool holds the SF
// Activity id, "pending" is reserved for a future async-confirmation path.
export type ActivityReconciliationStatus = "reconciled" | "pending";

// E-12 success body (202 Accepted).
export interface SendEmailResponseBody {
  readonly emailId: string;
  readonly participantId: string;
  readonly sentAt: string;
  readonly subject: string;
  readonly activityId: string;
  readonly activityReconciliationStatus: ActivityReconciliationStatus;
  readonly consentChecked: boolean;
}
