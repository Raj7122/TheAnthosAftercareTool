import { describe, expect, it, vi } from "vitest";

import { SalesforceConnectedAppAuth } from "../../src/salesforce/connected-app-auth.js";
import { SalesforceError } from "../../src/salesforce/types.js";

// Distinctive (but low-entropy / obviously-fake) credential values so the
// secret-leak assertions are meaningful without tripping the no-secrets lint.
const VALID_OPTS = {
  consumerKey: "test-consumer-key-placeholder",
  consumerSecret: "test-consumer-secret-placeholder",
  loginUrl: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
  refreshToken: "test-refresh-token-placeholder",
} as const;

function tokenBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "00DU800000DHR9BMAX!ACCESS",
    instance_url: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
    token_type: "Bearer",
    issued_at: "1716240000000",
    signature: "c2lnPQ==",
    scope: "api refresh_token",
    id: "https://login.salesforce.com/id/00D/005",
    ...overrides,
  });
}

// Minimal `fetch` stand-in: returns a Response-like object with `ok`,
// `status`, and `text()`. Cast through unknown — only the fields the auth
// class reads are populated.
function makeFetch(payload: {
  ok?: boolean;
  status?: number;
  body: string;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: payload.ok ?? true,
    status: payload.status ?? 200,
    text: async () => payload.body,
  }));
}

describe("SalesforceConnectedAppAuth", () => {
  it("exchanges the refresh token and returns access token + instance URL", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await auth.getAccessToken()).toBe("00DU800000DHR9BMAX!ACCESS");
    expect(await auth.getInstanceUrl()).toBe(
      "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
    );
    // Both getters share one token fetch (cached within TTL).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts the refresh-token grant form to the SF token endpoint", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await auth.getAccessToken();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://anthoshome3--pursuit.sandbox.my.salesforce.com/services/oauth2/token",
    );
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe(VALID_OPTS.consumerKey);
    expect(params.get("client_secret")).toBe(VALID_OPTS.consumerSecret);
    expect(params.get("refresh_token")).toBe(VALID_OPTS.refreshToken);
  });

  it("normalizes a trailing slash on the login URL", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      loginUrl: `${VALID_OPTS.loginUrl}/`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await auth.getAccessToken();

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe(
      "https://anthoshome3--pursuit.sandbox.my.salesforce.com/services/oauth2/token",
    );
  });

  it("caches the token until 80% of `expires_in` elapses, then refreshes", async () => {
    const fetchImpl = makeFetch({ body: tokenBody({ expires_in: 7200 }) });
    let clock = 1_000_000;
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    await auth.getAccessToken();
    // TTL = 0.8 × 7200s = 5_760_000ms. Still inside the window — cached.
    clock += 5_000_000;
    await auth.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past the window — a fresh token is fetched.
    clock += 1_000_000;
    await auth.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to a conservative TTL when `expires_in` is absent", async () => {
    // Salesforce's refresh-token grant frequently omits `expires_in`.
    const fetchImpl = makeFetch({ body: tokenBody() });
    let clock = 1_000_000;
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    await auth.getAccessToken();
    // Fallback TTL is 10 minutes — inside it the token is cached.
    clock += 5 * 60_000;
    await auth.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past 10 minutes — refresh.
    clock += 6 * 60_000;
    await auth.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws SF_AUTH_FAILED when a credential is missing", () => {
    expect(
      () =>
        new SalesforceConnectedAppAuth({
          ...VALID_OPTS,
          refreshToken: "",
        }),
    ).toThrowError(SalesforceError);
    try {
      new SalesforceConnectedAppAuth({ ...VALID_OPTS, refreshToken: "  " });
      expect.unreachable("constructor should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SalesforceError);
      expect((err as SalesforceError).code).toBe("SF_AUTH_FAILED");
      // The env-var NAME is a safe hint; no value is echoed.
      expect((err as SalesforceError).message).toContain(
        "SF_CONNECTED_APP_REFRESH_TOKEN",
      );
    }
  });

  it("maps a non-OK token response to SF_AUTH_FAILED with the OAuth error code", async () => {
    const fetchImpl = makeFetch({
      ok: false,
      status: 400,
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: "expired access/refresh token",
      }),
    });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(auth.getAccessToken()).rejects.toMatchObject({
      code: "SF_AUTH_FAILED",
    });
    await expect(auth.getAccessToken()).rejects.toThrow(/invalid_grant/);
  });

  it("maps a non-JSON success body to SF_AUTH_FAILED", async () => {
    const fetchImpl = makeFetch({ body: "<html>maintenance</html>" });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      code: "SF_AUTH_FAILED",
    });
  });

  it("throws SF_AUTH_FAILED when the response omits access_token", async () => {
    const fetchImpl = makeFetch({
      body: JSON.stringify({ instance_url: VALID_OPTS.loginUrl }),
    });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      code: "SF_AUTH_FAILED",
    });
  });

  it("throws SF_AUTH_FAILED when the response omits instance_url", async () => {
    const fetchImpl = makeFetch({
      body: JSON.stringify({ access_token: "00DU800000DHR9BMAX!ACCESS" }),
    });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(auth.getInstanceUrl()).rejects.toMatchObject({
      code: "SF_AUTH_FAILED",
    });
  });

  it("maps an aborted request to SF_NETWORK_TIMEOUT", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("the operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      code: "SF_NETWORK_TIMEOUT",
    });
  });

  it("maps a generic network failure to SF_AUTH_FAILED", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const auth = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      code: "SF_AUTH_FAILED",
    });
  });

  it("never echoes the consumer secret or refresh token in error messages", async () => {
    // Non-OK response path.
    const httpFail = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: makeFetch({
        ok: false,
        status: 401,
        body: JSON.stringify({ error: "invalid_client" }),
      }) as unknown as typeof fetch,
    });
    // Network-error path.
    const netFail = new SalesforceConnectedAppAuth({
      ...VALID_OPTS,
      fetchImpl: vi.fn(async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch,
    });

    for (const auth of [httpFail, netFail]) {
      const err = await auth.getAccessToken().then(
        () => {
          throw new Error("expected a rejection");
        },
        (e: unknown) => e as Error,
      );
      expect(err.message).not.toContain(VALID_OPTS.consumerSecret);
      expect(err.message).not.toContain(VALID_OPTS.refreshToken);
    }
  });
});
