import { describe, expect, it, vi } from "vitest";

import { exchangeRefreshToken } from "../../src/salesforce/refresh-token.js";
import { SalesforceError } from "../../src/salesforce/types.js";

// Distinctive (but obviously-fake) values so the secret-leak assertions are
// meaningful without tripping a no-secrets lint.
const VALID_INPUT = {
  refreshToken: "5Aep861refreshplaceholder",
  clientId: "test-client-id-placeholder",
  clientSecret: "test-client-secret-placeholder",
  loginUrl: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
} as const;

function tokenBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "00DU800000DHR9BMAX!ACCESS",
    instance_url: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
    scope: "api refresh_token",
    token_type: "Bearer",
    issued_at: "1716240000000",
    ...overrides,
  });
}

// Minimal `fetch` stand-in — only the fields the function reads are populated.
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

describe("exchangeRefreshToken", () => {
  it("returns the access token, instance URL, and scope on a non-rotating grant", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    const result = await exchangeRefreshToken(VALID_INPUT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      accessToken: "00DU800000DHR9BMAX!ACCESS",
      instanceUrl: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
      scope: "api refresh_token",
    });
    // No `refresh_token` in the response → no `refreshToken` on the result;
    // the caller retains the existing refresh token.
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresIn).toBeUndefined();
  });

  it("surfaces a rotated refresh token when the Connected App returns one", async () => {
    const fetchImpl = makeFetch({
      body: tokenBody({ refresh_token: "5Aep861-ROTATED-REFRESH-TOKEN-placeholder" }),
    });
    const result = await exchangeRefreshToken(VALID_INPUT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.refreshToken).toBe("5Aep861-ROTATED-REFRESH-TOKEN-placeholder");
  });

  it("surfaces a positive finite expires_in and drops a non-positive one", async () => {
    const withTtl = await exchangeRefreshToken(VALID_INPUT, {
      fetchImpl: makeFetch({
        body: tokenBody({ expires_in: 7200 }),
      }) as unknown as typeof fetch,
    });
    expect(withTtl.expiresIn).toBe(7200);

    for (const bad of [0, -1, "3600", null]) {
      const result = await exchangeRefreshToken(VALID_INPUT, {
        fetchImpl: makeFetch({
          body: tokenBody({ expires_in: bad }),
        }) as unknown as typeof fetch,
      });
      expect(result.expiresIn).toBeUndefined();
    }
  });

  it("posts the refresh_token grant form", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    await exchangeRefreshToken(VALID_INPUT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://anthoshome3--pursuit.sandbox.my.salesforce.com/services/oauth2/token",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe(VALID_INPUT.refreshToken);
    expect(params.get("client_id")).toBe(VALID_INPUT.clientId);
    expect(params.get("client_secret")).toBe(VALID_INPUT.clientSecret);
  });

  it("normalizes a trailing slash on the login URL", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    await exchangeRefreshToken(
      { ...VALID_INPUT, loginUrl: `${VALID_INPUT.loginUrl}/` },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe(
      "https://anthoshome3--pursuit.sandbox.my.salesforce.com/services/oauth2/token",
    );
  });

  it("maps a rejected exchange (invalid_grant) to SF_AUTH_FAILED", async () => {
    const fetchImpl = makeFetch({
      ok: false,
      status: 400,
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: "expired access/refresh token",
      }),
    });
    await expect(
      exchangeRefreshToken(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "SF_AUTH_FAILED" });
  });

  it("maps a non-JSON success body to SF_AUTH_FAILED", async () => {
    const fetchImpl = makeFetch({ body: "<html>maintenance</html>" });
    await expect(
      exchangeRefreshToken(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "SF_AUTH_FAILED" });
  });

  it("throws SF_AUTH_FAILED when the response omits access_token / instance_url", async () => {
    for (const missing of ["access_token", "instance_url"]) {
      const fetchImpl = makeFetch({ body: tokenBody({ [missing]: undefined }) });
      await expect(
        exchangeRefreshToken(VALID_INPUT, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toBeInstanceOf(SalesforceError);
    }
  });

  it("maps an aborted request to SF_NETWORK_TIMEOUT", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("the operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(
      exchangeRefreshToken(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "SF_NETWORK_TIMEOUT" });
  });

  it("never echoes the refresh token or client_secret in error messages", async () => {
    const httpFail = makeFetch({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    });
    const netFail = vi.fn(async () => {
      throw new Error("connection reset");
    });

    for (const fetchImpl of [httpFail, netFail]) {
      const err = await exchangeRefreshToken(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).then(
        () => {
          throw new Error("expected a rejection");
        },
        (e: unknown) => e as Error,
      );
      expect(err.message).not.toContain(VALID_INPUT.refreshToken);
      expect(err.message).not.toContain(VALID_INPUT.clientSecret);
    }
  });
});
