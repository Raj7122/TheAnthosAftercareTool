import type {
  CommunicationConsent,
  ParticipantAddress,
  ParticipantContact,
  PreferredContactMethod,
} from "@anthos/api";

import { maskPhone } from "../_lib/mask-phone";

interface Props {
  readonly contact: ParticipantContact;
  readonly communicationConsent: CommunicationConsent;
  readonly preferredContactMethod: PreferredContactMethod;
}

// F-07 wireframe contact-preferences card. Replaces the lower half of the
// retired IdentityCard (phone/email/address + SMS/email consent + preferred
// channel) and adds the quiet-hours line — which is hard-coded to 9 PM —
// 8 AM ET per immutable #4 (the notifications layer enforces this, not the
// user; rendering the constant matches the running behavior).
//
// Tri-state consent rendering preserved from IdentityCard: `null` is the
// canonical "unknown" today (P1F-01 stub posture — no SF source for
// SMS/email consent yet). Quiet hours fails closed on unknown at the
// notifications layer; the UI still SHOWS unknown.
export function ContactPreferencesCard({
  contact,
  communicationConsent,
  preferredContactMethod,
}: Props) {
  return (
    <section
      aria-labelledby="contact-preferences-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <h2
        id="contact-preferences-heading"
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Contact preferences
      </h2>
      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Preferred channel" value={preferredLabel(preferredContactMethod)} />
        <Row label="Phone" value={maskPhone(contact.phone)} />
        <Row label="Email" value={contact.email ?? "—"} />
        <Row label="Address" value={formatAddress(contact.address)} />
        <Row
          label="SMS consent (Mogli)"
          value={consentLabel(communicationConsent.sms)}
        />
        <Row
          label="Email consent"
          value={consentLabel(communicationConsent.email)}
        />
        <Row label="Quiet hours" value="9:00 PM — 8:00 AM ET" />
      </dl>
    </section>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function consentLabel(value: boolean | null): string {
  if (value === null) return "Unknown";
  return value ? "Consented" : "Not consented";
}

function preferredLabel(value: PreferredContactMethod): string {
  if (value === null) return "—";
  if (value === "phone") return "Phone";
  if (value === "email") return "Email";
  return "Text";
}

function formatAddress(address: ParticipantAddress): string {
  const parts = [
    address.street,
    [address.city, address.state]
      .filter((s): s is string => s !== null)
      .join(", "),
    address.zip,
  ]
    .map((s) => (s === null || s === "" ? null : s))
    .filter((s): s is string => s !== null);
  if (parts.length === 0) return "—";
  return parts.join(" · ");
}
