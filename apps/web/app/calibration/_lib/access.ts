// Phase-0 calibration feature-flag gate. The OAuth + PKCE rule
// is preserved by routing Salesforce reads through the BFF; per-user identity
// for the gate is a Phase-0 stub via `?as=<email>` and a server-read allowlist
// env var. Real per-user OAuth lands in Phase 1; this shape maps cleanly to
// LaunchDarkly user-segments in Production Mode (ARC-22).
export function isAllowed(identity: string | null | undefined): boolean {
  if (identity === null || identity === undefined || identity === "") return false;
  const list = (process.env["CALIBRATION_ALLOWLIST"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.includes(identity.trim().toLowerCase());
}
