// P1H-11 (demo) — SMS + email message templates for the communications
// workflow. The register (warm, low-pressure, opt-in tone) is not specified
// in any contract; this copy was provided by the product owner for the demo.
//
// Sender name is hard-coded to "Marie" to match the SMS/email mockups. In
// production this should resolve to the authenticated specialist's
// `displayName` from `/me` (the demo logs in as Rajiv → "Marie Alcis").
//
// SMS templates do NOT personalize (they open with "Hi —"). Email's longer
// form reads cold without a name, so it carries a `{{firstName}}` token
// resolved at compose time from the participant's display name. The real
// email send goes through a tool-owned Salesforce Flow (P2-05) whose
// templating syntax must be confirmed before that path ships — the
// client-side substitution here is demo-only.

export const SENDER_NAME = "Marie" as const;

export const FIRST_NAME_TOKEN = "{{firstName}}" as const;

// The three template intents, shared across SMS and email.
export type TemplateKey = "checkin" | "reminder" | "voucher";

export interface TemplateOption {
  readonly key: TemplateKey;
  readonly label: string;
}

// Dropdown order matches the mockups: check-in first (the default), then the
// two reminders.
export const TEMPLATE_OPTIONS: ReadonlyArray<TemplateOption> = [
  { key: "checkin", label: "Check-in" },
  { key: "reminder", label: "Stability visit reminder" },
  { key: "voucher", label: "Voucher recertification reminder" },
];

export const DEFAULT_TEMPLATE_KEY: TemplateKey = "checkin";

// --- SMS ---------------------------------------------------------------------

export const SMS_TEMPLATES: Readonly<Record<TemplateKey, string>> = {
  checkin: `Hi — ${SENDER_NAME} from Anthos checking in. How are things going? Reply when you have a moment.`,
  reminder: `Hi — ${SENDER_NAME} from Anthos. Just a reminder we have a stability visit coming up. Will send the time soon.`,
  voucher: `Hi — ${SENDER_NAME} from Anthos. Your voucher recertification deadline is approaching. Let me know when we can talk.`,
};

// --- Email -------------------------------------------------------------------

export interface EmailTemplate {
  readonly subject: string;
  readonly body: string;
}

export const EMAIL_TEMPLATES: Readonly<Record<TemplateKey, EmailTemplate>> = {
  checkin: {
    subject: "Checking in from Anthos",
    body: `Hi ${FIRST_NAME_TOKEN},

This is ${SENDER_NAME} from Anthos. I wanted to check in and see how things have been going lately. There's nothing urgent on my end — I just like to stay in touch.

If there's anything you'd like to talk through, or any support you're looking for, reply to this email whenever it's convenient and we'll find a time to connect.

Take care,
${SENDER_NAME}
Anthos Aftercare`,
  },
  reminder: {
    subject: "Upcoming stability visit",
    body: `Hi ${FIRST_NAME_TOKEN},

This is ${SENDER_NAME} from Anthos. I wanted to let you know we have a stability visit coming up. I'll follow up shortly with the exact date and time so we can confirm what works for you.

If you have any questions before then, or if there's a day or time that's better for you, just reply to this email and let me know.

Looking forward to seeing you,
${SENDER_NAME}
Anthos Aftercare`,
  },
  voucher: {
    subject: "Voucher recertification deadline approaching",
    body: `Hi ${FIRST_NAME_TOKEN},

This is ${SENDER_NAME} from Anthos. I wanted to give you a heads-up that your voucher recertification deadline is coming up. I don't want this to lapse, so I'd like to help you get everything in order well ahead of time.

Please reply to this email and let me know when we can talk through the steps. If there's any paperwork you're unsure about, we can go over it together.

Best,
${SENDER_NAME}
Anthos Aftercare`,
  },
};

// Derive a usable first name from the participant's full display name. The
// wire DTO carries only `displayName` (e.g. "GRAD Alfred Cooper" or "Alfred
// Cooper"); we take the last whitespace-delimited token that looks like a
// given name is unreliable, so we take the first alphabetic token and fall
// back to a friendly generic. PII note: the name only ever lives in the
// compose surface text, never in logs.
export function deriveFirstName(displayName: string | null): string {
  if (displayName === null) return "there";
  const tokens = displayName.trim().split(/\s+/).filter((t) => t.length > 0);
  // Skip a leading enrollment-status prefix like "GRAD" (all-caps, no
  // lowercase) so "GRAD Alfred Cooper" → "Alfred".
  const named = tokens.find((t) => /[a-z]/.test(t)) ?? tokens[0];
  return named === undefined || named === "" ? "there" : named;
}

// Replace every `{{firstName}}` occurrence. Used on email subject + body.
export function applyTemplate(text: string, firstName: string): string {
  return text.split(FIRST_NAME_TOKEN).join(firstName);
}
