// BR-40 phone-masking for the F-07 identity card. The E-08 wire body returns
// the raw phone (see `packages/api/src/participants/dto.ts` —
// `phoneRevealable: false` until a reveal-permission mechanism exists; UI-side
// masking is the SPA's job until then). This module is the single masking
// rule for the participant-detail page; do not bypass it.
//
// Output is the standard last-4-visible mask; bullet glyphs sit cleanly in
// tabular numerals so the cell width stays stable across rows. Inputs come
// off Salesforce with mixed punctuation (parentheses, hyphens, dots, +1
// prefixes) — we strip to digits first, then re-frame.
const DASH = "—";

export function maskPhone(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return DASH;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return DASH;
  if (digits.length < 4) {
    // Sub-4-digit string is almost certainly junk data; never reveal it.
    return "(•••) •••-••••";
  }
  const last4 = digits.slice(-4);
  return `(•••) •••-${last4}`;
}
