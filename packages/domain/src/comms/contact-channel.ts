// Shared contact-channel classifier. A logged contact arrives from Salesforce
// as free-form label variants ("Outbound SMS", "Phone Call", "Stability
// Meeting", "Email", "In Person", "Text/SMS") spread across caseNoteType /
// contactType / channel fields. Several surfaces map those to a small set of
// channel kinds via lowercase-substring matching (no maintained lookup table):
// the Recent Contacts timeline, the activity calendar, and the caseload
// activity endpoint (server-side). Pure — no I/O — so it lives in @anthos/domain
// and is shared across the host surfaces and the BFF.

export type ContactChannelKind = "phone" | "sms" | "email" | "visit";

export function classifyContactChannel(
  parts: ReadonlyArray<string | null>,
): ContactChannelKind {
  const haystack = parts
    .filter((s): s is string => s !== null && s !== "")
    .join(" ")
    .toLowerCase();
  if (haystack.includes("sms") || haystack.includes("text")) return "sms";
  if (haystack.includes("email")) return "email";
  if (
    haystack.includes("visit") ||
    haystack.includes("meeting") ||
    haystack.includes("in person") ||
    haystack.includes("in-person") ||
    haystack.includes("zoom") ||
    haystack.includes("virtual")
  ) {
    return "visit";
  }
  return "phone";
}
