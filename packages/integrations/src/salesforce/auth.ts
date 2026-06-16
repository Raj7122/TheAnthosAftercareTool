import { spawn } from "node:child_process";

import { SalesforceError, type SalesforceAuth } from "./types.js";

// Phase 0 auth: reads access token + instance URL from the local `sf` CLI
// keychain. Mirrors how PF-04's Salesforce MCP server reaches the sandbox
// today. Per-specialist OAuth+PKCE refresh tokens arrive in F-01 (Phase 1)
// by writing a new `SalesforceAuth` impl — this one stays for local
// engineering work against the anonymized sandbox.
//
// Immutable #3 (OAuth 2.0 + PKCE for all Salesforce auth): the PKCE flow
// runs once at `sf org login web` time and the resulting refresh-token-
// derived access token lives in the CLI keychain. This auth class never
// touches a client secret, never invokes a password flow, and never
// surfaces the token to logs.

const DEFAULT_ORG_ALIAS = "anthos-demo";
// The OAuth convention specifies "refresh at 80% of TTL." The `sf` CLI
// keychain does not surface the access-token expiry timestamp, so Phase 0
// substitutes a 5-minute pre-expiry refresh buffer. Phase 1 / F-01 receives
// the expiry directly from the OAuth token response and will implement the
// 80%-TTL rule precisely.
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

interface CachedTokenInfo {
  accessToken: string;
  instanceUrl: string;
  fetchedAt: number;
}

interface SfOrgDisplayResult {
  result: {
    accessToken?: string;
    instanceUrl?: string;
    username?: string;
  };
}

export interface SfCliKeychainAuthOptions {
  readonly orgAlias?: string;
  readonly spawnImpl?: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readonly now?: () => number;
}

export class SfCliKeychainAuth implements SalesforceAuth {
  private readonly orgAlias: string;
  private readonly spawnImpl: NonNullable<SfCliKeychainAuthOptions["spawnImpl"]>;
  private readonly now: () => number;
  private cached: CachedTokenInfo | null = null;

  constructor(options: SfCliKeychainAuthOptions = {}) {
    this.orgAlias = options.orgAlias ?? DEFAULT_ORG_ALIAS;
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const info = await this.resolve();
    return info.accessToken;
  }

  async getInstanceUrl(): Promise<string> {
    const info = await this.resolve();
    return info.instanceUrl;
  }

  private async resolve(): Promise<CachedTokenInfo> {
    if (
      this.cached !== null &&
      this.now() - this.cached.fetchedAt < TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.cached;
    }

    const args = ["org", "display", "--target-org", this.orgAlias, "--json"];
    const { stdout, stderr, exitCode } = await this.spawnImpl("sf", args);

    // `sf` exit code is unreliable: plugin-load warnings (e.g. release-
    // management) push it to non-zero while the main command still emits
    // valid JSON on stdout. Parse first, then decide. stderr stays out of
    // logs except on parse failure — never carries token material (token
    // lives in stdout JSON).
    // `sf` may prepend plugin-load warnings to stdout when its CLI plugins
    // are partially installed (`(node:NNN) Error Plugin: ...`). Extract the
    // first balanced JSON object instead of demanding a clean stdout.
    // Stderr is intentionally NOT surfaced in the error message — it may
    // carry session context (org alias, username, partial credential refs);
    // callers get a generic "re-run sf org login web" hint. The diagnostic
    // text is available locally via `sf` itself.
    let parsed: SfOrgDisplayResult | null = null;
    try {
      parsed = JSON.parse(extractFirstJsonObject(stdout)) as SfOrgDisplayResult;
    } catch {
      void stderr;
      throw new SalesforceError(
        "SF_AUTH_FAILED",
        `sf CLI exited ${exitCode} and stdout has no JSON; re-run \`sf org login web\``,
      );
    }

    const accessToken = parsed.result?.accessToken;
    const instanceUrl = parsed.result?.instanceUrl;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new SalesforceError(
        "SF_AUTH_FAILED",
        "sf CLI did not return an access token (re-run `sf org login web`)",
      );
    }
    if (typeof instanceUrl !== "string" || instanceUrl.length === 0) {
      throw new SalesforceError(
        "SF_AUTH_FAILED",
        "sf CLI did not return an instance URL",
      );
    }

    // stderr is intentionally ignored — `sf` writes Node deprecation warnings
    // there even on success. We never log token material; the swallow is
    // deliberate.
    void stderr;

    this.cached = {
      accessToken,
      instanceUrl,
      fetchedAt: this.now(),
    };
    return this.cached;
  }
}

// Locate the SF `--json` payload in stdout. `sf` may prepend plugin-load
// warnings (with their own brace blocks) before the real JSON, so we anchor
// on the `"status":` field that always opens `sf` JSON output and walk back
// to the enclosing `{`. Returns the original `text` unchanged if no anchor
// is present — caller's JSON.parse will then fail cleanly.
function extractFirstJsonObject(text: string): string {
  const anchorIdx = text.search(/"status"\s*:/);
  if (anchorIdx === -1) return text;
  // Walk back to the opening `{` that owns the anchor.
  let start = -1;
  for (let i = anchorIdx; i >= 0; i--) {
    if (text[i] === "{") {
      start = i;
      break;
    }
  }
  if (start === -1) return text;
  // Walk forward to the matching `}`.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

async function defaultSpawn(
  command: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Strip inherited NODE_OPTIONS / VITEST_* flags so when this auth runs from
  // a Vitest worker, the `sf` CLI doesn't try to re-load Vitest's instrumentation
  // and corrupt its stdout with deprecation banners. Token material never lives
  // in env vars — clearing them is safe.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST_") || key.startsWith("VITE_")) delete env[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
