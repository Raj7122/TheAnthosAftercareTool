// CSP `frame-ancestors` configuration for the SPA shell (TR-AUTH-5, API §8).
//
// `frame-ancestors` is the iframe parent-frame trust boundary: it names the
// origins permitted to EMBED this app. Only Anthos's Salesforce domains may.
// `X-Frame-Options` is deliberately NOT set anywhere — TR-AUTH-5: it "MUST NOT
// be used" (deprecated; CSP supersedes).
//
// This is a DIFFERENT allowlist from the Origin-validation list (which origin
// a mutation request may come FROM — the BFF's own origin; see
// packages/api/src/origin/config.ts).
//
// The allowlist is env-driven (`ANTHOS_CSP_FRAME_ANCESTORS`) so sandbox and
// production carry their own values with no code change — the open product
// question (a tighter, instance-specific allowlist confirmed with the Anthos
// SF admin before cutover) then resolves to an env-var change, not a code one.
//
// Self-contained — no imports — so `next.config.ts` can consume it at build
// time with no module-resolution shim.

export interface CspConfig {
  readonly frameAncestors: string;
}

export const ENV_FRAME_ANCESTORS = "ANTHOS_CSP_FRAME_ANCESTORS";

// API §8 example allowlist — permissive across Salesforce Lightning subdomains.
// Anthos may tighten this to an instance-specific host via the env var.
export const DEFAULT_FRAME_ANCESTORS =
  "https://*.lightning.force.com https://*.salesforce.com";

type Env = Record<string, string | undefined>;

// Resolve the effective `frame-ancestors` source list from the environment
// (defaults to `process.env`). Absent / empty → the API §8 default above.
export function loadCspConfig(env: Env = process.env): CspConfig {
  const raw = env.ANTHOS_CSP_FRAME_ANCESTORS;
  const frameAncestors =
    raw === undefined || raw.trim().length === 0
      ? DEFAULT_FRAME_ANCESTORS
      : raw.trim().replace(/\s+/g, " ");
  return { frameAncestors };
}

// Build the `Content-Security-Policy` header value. Only the `frame-ancestors`
// directive is set — this header governs iframe embedding, not script/style
// policy, which is out of this ticket's scope.
export function buildFrameAncestorsCsp(config: CspConfig): string {
  return `frame-ancestors ${config.frameAncestors}`;
}
