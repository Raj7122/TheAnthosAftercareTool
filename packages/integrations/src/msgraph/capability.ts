// MS Graph capability check (P3A-01 / F-12). The deployed tool authenticates to
// Microsoft Graph via the PF-08 Entra app registration (client-credentials).
// When the three credential env vars are present, Outlook calendar operations
// are LIVE; when absent — the Demo posture in `anthoshome3--pursuit`, which has
// no Graph creds / writable mailbox — calendar operations DEGRADE: the visit
// endpoints write the Salesforce side only and surface a null Outlook event id.
//
// The capability is a boolean seam, not a stub method: `MSGraphClient.fromEnv()`
// returns `null` here, the handlers proceed SF-only, and flipping creds on later
// requires zero handler changes.

export interface MsGraphCredentials {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Resolves Graph credentials from the environment, or null when any are absent.
// Mirrors the PF-08 / .env.example var names (MS_TENANT_ID, MS_GRAPH_CLIENT_ID,
// MS_GRAPH_CLIENT_SECRET).
export function resolveMsGraphCredentials(
  env: NodeJS.ProcessEnv = process.env,
): MsGraphCredentials | null {
  const tenantId = env.MS_TENANT_ID;
  const clientId = env.MS_GRAPH_CLIENT_ID;
  const clientSecret = env.MS_GRAPH_CLIENT_SECRET;
  if (nonEmpty(tenantId) && nonEmpty(clientId) && nonEmpty(clientSecret)) {
    return { tenantId, clientId, clientSecret };
  }
  return null;
}

export function msGraphAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveMsGraphCredentials(env) !== null;
}
