// P1H-11 (demo) — shared types for the specialist communications workflow.
//
// Demo posture: SMS / email / schedule sends are CLIENT-ONLY. No Mogli, no
// Salesforce Flow, no Microsoft Graph round-trip. The real channels (F-09 /
// F-12 / email) ship later and own the endpoints, server-side authz/consent
// gating, audit (Pattern B), idempotency (Pattern D), and quiet-hours
// enforcement. Nothing here mutates server state, so there is no Pattern
// B/D obligation on this path.

export type CommsChannel = "sms" | "email" | "schedule" | "call";

// A locally-composed send, surfaced optimistically in the Recent Contacts
// timeline. This is deliberately NOT the wire `ParticipantRecentContact`
// (whose `provenance` is fixed to `"pe_rollup"` = "via Salesforce") — a demo
// send is "via tool" and must not masquerade as a Salesforce-sourced record.
export interface OptimisticSend {
  // Stable key for React list rendering. Caller mints it
  // (`crypto.randomUUID()`); no server id exists for a client-only send.
  readonly id: string;
  readonly channel: CommsChannel;
  // Label rendered in the timeline row (e.g. "Outbound SMS", "Email",
  // "Stability visit"). Drives the channel glyph via the timeline's
  // substring matcher.
  readonly label: string;
  // Free-text body shown after the label. SMS/email message body or the
  // schedule note; may be empty.
  readonly summary: string;
  // "Sent" for SMS/email, "Scheduled" for a visit. Normalized to the
  // timeline's COMPLETED/ATTEMPTED badge.
  readonly status: string;
  // ISO 8601 instant the specialist hit Send (client clock — demo only).
  readonly timestamp: string;
  // The date this event belongs ON for calendar plotting, when it differs
  // from `timestamp`. A scheduled visit lands on its visit date (future),
  // not the moment it was booked. SMS/email omit this and fall back to
  // `timestamp`. ISO date (YYYY-MM-DD) or ISO 8601.
  readonly eventDate?: string;
  // P1H-11 wired path (SMS/email/schedule now hit real endpoints): the
  // Salesforce record id the BFF returned (Mogli SMS / Activity / Case Note),
  // and the X-Trace-Id correlating this optimistic row to the BFF's
  // pre-response Pattern B audit row. Absent on the client-only call channel.
  readonly serverId?: string | null;
  readonly traceId?: string | null;
}
