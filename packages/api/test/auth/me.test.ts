import {
  computePermissionsHash,
  hashToken,
  loadSessionConfig,
  mintToken,
} from "@anthos/auth";
import type { Role } from "@anthos/auth";
import {
  createFeatureFlagClient,
  LocalFeatureFlagProvider,
} from "@anthos/feature-flags";
import type { FeatureFlagClient, FlagRule } from "@anthos/feature-flags";
import { describe, expect, it, vi } from "vitest";

import { handleMe, ME_FEATURE_FLAG_KEYS } from "../../src/auth/me.js";
import type { AuthMeOptions } from "../../src/auth/me.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const CONFIG = loadSessionConfig({}); // 30-min idle, 12-h absolute
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const SPECIALIST_ID = "0058K00000XYZAbQAO";
const DISPLAY_NAME = "Marie Alcis";
const EMAIL = "malcis@anthoshome.org";
const TIMEZONE = "America/New_York";

// The flat API §7.2.5 response body — no `data` / `meta` wrapper.
interface MeBody {
  readonly specialistId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly timezone: string;
  readonly permissionsHash: string;
  readonly sessionExpiresAt: string;
  readonly firstRunCompleted: boolean;
  readonly features: Record<string, boolean>;
  readonly barrierTypes: ReadonlyArray<string>;
}

interface SeedOpts {
  readonly specialistId?: string;
  readonly role?: Role;
  // `null` models a session minted before the P1B-05 identity-capture
  // migration; omitted uses the default identity.
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly timezone?: string | null;
  readonly lastActivityAt?: Date;
  readonly expiresAt?: Date;
  readonly revoked?: boolean;
}

// In-memory SessionStore — `withSession` resolves seeded rows by token hash.
// `/me` never creates a session, so `create` rejects to flag misuse.
function makeStore(): { store: SessionStore; seed: (opts?: SeedOpts) => string } {
  const rows = new Map<string, SessionRecord>();
  let n = 0;
  const store: SessionStore = {
    create: () => Promise.reject(new Error("create is not used by /me tests")),
    getByTokenHash: (tokenHash) => Promise.resolve(rows.get(tokenHash) ?? null),
    getSalesforceRefreshToken: () => Promise.resolve(null),
    touch: () => Promise.resolve(),
    applySessionRefresh: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    cleanupExpired: () => Promise.resolve(0),
  };
  function seed(opts: SeedOpts = {}): string {
    n += 1;
    const token = mintToken();
    rows.set(hashToken(token), {
      id: `session-${n}`,
      specialistId: opts.specialistId ?? SPECIALIST_ID,
      role: opts.role ?? "SPECIALIST",
      lastActivityAt: opts.lastActivityAt ?? new Date(),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 11 * HOUR),
      revoked: opts.revoked ?? false,
      displayName: opts.displayName === undefined ? DISPLAY_NAME : opts.displayName,
      email: opts.email === undefined ? EMAIL : opts.email,
      timezone: opts.timezone === undefined ? TIMEZONE : opts.timezone,
    });
    return token;
  }
  return { store, seed };
}

// A FeatureFlagClient backed by the real Demo-Mode provider, seeded with an
// explicit rule map — exercises the actual flag-evaluation path.
function makeFlagClient(
  rules: Iterable<readonly [string, FlagRule]> = [],
): FeatureFlagClient {
  return createFeatureFlagClient(new LocalFeatureFlagProvider(new Map(rules)));
}

function meReq(token?: string, traceId?: string): Request {
  const headers = new Headers();
  if (token !== undefined) {
    headers.set("Cookie", `anthos_session=${token}`);
  }
  if (traceId !== undefined) {
    headers.set("X-Trace-Id", traceId);
  }
  return new Request("https://bff.test/api/v1/me", { method: "GET", headers });
}

// Base options — store + config + a (no-rules) flag client + a stub first-run
// lookup, so no test touches a real DB, flag backend, or the env.
function baseOptions(
  store: SessionStore,
  overrides: Partial<AuthMeOptions> = {},
): AuthMeOptions {
  return {
    store,
    config: CONFIG,
    featureFlagClient: makeFlagClient(),
    firstRunLookup: () => Promise.resolve(false),
    barrierTypesLookup: () => ["Domestic Violence", "Cannot reach participant"],
    ...overrides,
  };
}

// ── success (E-05, API §7.2.5) ──────────────────────────────────────────────

describe("handleMe — success (E-05)", () => {
  it("returns 200 with the flat §7.2.5 envelope — exactly ten fields, no wrapper", async () => {
    const { store, seed } = makeStore();
    const expiresAt = new Date(Date.now() + 11 * HOUR);
    const token = seed({ expiresAt });

    const res = await handleMe(meReq(token), baseOptions(store));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();

    const body = (await res.json()) as MeBody;
    // The body IS the resource — no `data` / `meta` keys (API §7.1.1).
    expect(Object.keys(body).sort()).toEqual(
      [
        "barrierTypes",
        "displayName",
        "email",
        "features",
        "firstRunCompleted",
        "permissionsHash",
        "role",
        "sessionExpiresAt",
        "specialistId",
        "timezone",
      ],
    );
    expect(body.specialistId).toBe(SPECIALIST_ID);
    expect(body.displayName).toBe(DISPLAY_NAME);
    expect(body.email).toBe(EMAIL);
    expect(body.role).toBe("specialist");
    expect(body.timezone).toBe(TIMEZONE);
    expect(body.sessionExpiresAt).toBe(expiresAt.toISOString());
    expect(body.firstRunCompleted).toBe(false);
  });

  it("returns the F-06 Barrier Type picklist for session-start bootstrap (EC-22)", async () => {
    const { store, seed } = makeStore();
    const token = seed();

    const body = (await (
      await handleMe(
        meReq(token),
        baseOptions(store, {
          barrierTypesLookup: () => [
            "Domestic Violence",
            "Cannot reach participant",
            "Personal or medical emergency",
          ],
        }),
      )
    ).json()) as MeBody;

    expect(body.barrierTypes).toEqual([
      "Domestic Violence",
      "Cannot reach participant",
      "Personal or medical emergency",
    ]);
  });

  it("defaults barrierTypes to the FS v1.12 §F-06 ordered snapshot when no lookup is injected", async () => {
    const { store, seed } = makeStore();
    const token = seed();

    const body = (await (
      await handleMe(meReq(token), {
        store,
        config: CONFIG,
        featureFlagClient: makeFlagClient(),
        firstRunLookup: () => Promise.resolve(false),
      })
    ).json()) as MeBody;

    expect(body.barrierTypes).toContain("Domestic Violence");
    expect(body.barrierTypes).toContain("Cannot reach participant");
    expect(body.barrierTypes.length).toBe(27);
  });

  it("returns a permissionsHash derived from specialistId + role", async () => {
    const { store, seed } = makeStore();
    const token = seed();

    const body = (await (await handleMe(meReq(token), baseOptions(store))).json()) as MeBody;

    expect(body.permissionsHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(body.permissionsHash).toBe(
      computePermissionsHash(SPECIALIST_ID, "SPECIALIST"),
    );
  });

  it("lowercases the role for the wire enum — all four roles", async () => {
    const cases: ReadonlyArray<readonly [Role, string]> = [
      ["SPECIALIST", "specialist"],
      ["SUPERVISOR", "supervisor"],
      ["VP", "vp"],
      ["SYSTEM_ADMIN", "system_admin"],
    ];
    for (const [role, wire] of cases) {
      const { store, seed } = makeStore();
      const token = seed({ role });
      const body = (await (
        await handleMe(meReq(token), baseOptions(store))
      ).json()) as MeBody;
      expect(body.role).toBe(wire);
    }
  });

  it("resolves the features map over the four M-AI flags (fail-closed on unknown)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const flagClient = makeFlagClient([
      ["feature.m_ai.summary", { enabled: true }],
      ["feature.m_ai.voice", { enabled: false }],
      ["feature.m_ai.signal", { enabled: true }],
      // feature.m_ai.draft intentionally unregistered → resolves OFF.
    ]);

    const body = (await (
      await handleMe(meReq(token), baseOptions(store, { featureFlagClient: flagClient }))
    ).json()) as MeBody;

    expect(body.features).toEqual({
      "feature.m_ai.summary": true,
      "feature.m_ai.voice": false,
      "feature.m_ai.signal": true,
      "feature.m_ai.draft": false,
    });
    expect(Object.keys(body.features).sort()).toEqual([...ME_FEATURE_FLAG_KEYS].sort());
  });

  it("reflects firstRunCompleted from the lookup", async () => {
    const { store, seed } = makeStore();
    const token = seed();

    const body = (await (
      await handleMe(
        meReq(token),
        baseOptions(store, { firstRunLookup: () => Promise.resolve(true) }),
      )
    ).json()) as MeBody;

    expect(body.firstRunCompleted).toBe(true);
  });

  it("degrades firstRunCompleted to false when the lookup fails — never 500s the role gate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, seed } = makeStore();
    const token = seed();

    const res = await handleMe(
      meReq(token),
      baseOptions(store, {
        firstRunLookup: () => Promise.reject(new Error("notification_preferences unreachable")),
      }),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as MeBody).firstRunCompleted).toBe(false);
    warn.mockRestore();
  });

  it("never writes the specialist's display name or email to a log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store, seed } = makeStore();
    const token = seed();

    await handleMe(meReq(token), baseOptions(store));

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .map((c) => String(c[0]))
      .join("\n");
    expect(logged).not.toContain(DISPLAY_NAME);
    expect(logged).not.toContain(EMAIL);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

// ── auth gate + failure paths ───────────────────────────────────────────────

describe("handleMe — auth gate (withSession) + failure paths", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const res = await handleMe(meReq(), baseOptions(store));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("401 AUTH_SESSION_INVALID when the cookie token matches no session", async () => {
    const { store } = makeStore();
    const res = await handleMe(meReq(mintToken()), baseOptions(store));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("401 AUTH_SESSION_EXPIRED on an idle-expired session", async () => {
    const { store, seed } = makeStore();
    const token = seed({ lastActivityAt: new Date(Date.now() - 31 * MINUTE) });
    const res = await handleMe(meReq(token), baseOptions(store));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("401 AUTH_SESSION_EXPIRED on an absolutely-expired session", async () => {
    const { store, seed } = makeStore();
    const token = seed({ expiresAt: new Date(Date.now() - 1000) });
    const res = await handleMe(meReq(token), baseOptions(store));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("401 AUTH_SESSION_INVALID on a session predating identity capture (null identity)", async () => {
    const { store, seed } = makeStore();
    const token = seed({ displayName: null, email: null, timezone: null });
    const res = await handleMe(meReq(token), baseOptions(store));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("500 INTERNAL_ERROR when the session store is unreachable — never a spurious 401", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const brokenStore: SessionStore = {
      ...makeStore().store,
      getByTokenHash: () => Promise.reject(new Error("connection refused")),
    };

    const res = await handleMe(meReq(mintToken()), baseOptions(brokenStore));

    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("INTERNAL_ERROR");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();
    error.mockRestore();
  });
});
