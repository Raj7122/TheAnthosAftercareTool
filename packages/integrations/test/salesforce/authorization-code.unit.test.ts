import { describe, expect, it, vi } from "vitest";

import { exchangeAuthorizationCode } from "../../src/salesforce/authorization-code.js";
import { SalesforceError } from "../../src/salesforce/types.js";

// Distinctive (but obviously-fake) values so the secret-leak assertions are
// meaningful without tripping a no-secrets lint.
const VALID_INPUT = {
  code: "test-auth-code-placeholder",
  codeVerifier: "test-code-verifier-placeholder",
  clientId: "test-client-id-placeholder",
  clientSecret: "test-client-secret-placeholder",
  redirectUri: "https://bff.test/api/v1/auth/callback",
  loginUrl: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
} as const;

function tokenBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "00DU800000DHR9BMAX!ACCESS",
    refresh_token: "5Aep861refreshplaceholder",
    instance_url: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
    id: "https://login.salesforce.com/id/00D8K000000ABCDUA0/0058K00000XYZAbQAO",
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

describe("exchangeAuthorizationCode", () => {
  it("returns the access + refresh tokens, instance + identity URLs, and scope", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    const result = await exchangeAuthorizationCode(VALID_INPUT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      accessToken: "00DU800000DHR9BMAX!ACCESS",
      refreshToken: "5Aep861refreshplaceholder",
      instanceUrl: "https://anthoshome3--pursuit.sandbox.my.salesforce.com",
      identityUrl:
        "https://login.salesforce.com/id/00D8K000000ABCDUA0/0058K00000XYZAbQAO",
      scope: "api refresh_token",
    });
  });

  it("posts the authorization_code grant form, incl. the PKCE code_verifier", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    await exchangeAuthorizationCode(VALID_INPUT, {
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
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe(VALID_INPUT.code);
    expect(params.get("client_id")).toBe(VALID_INPUT.clientId);
    expect(params.get("client_secret")).toBe(VALID_INPUT.clientSecret);
    expect(params.get("redirect_uri")).toBe(VALID_INPUT.redirectUri);
    expect(params.get("code_verifier")).toBe(VALID_INPUT.codeVerifier);
  });

  it("normalizes a trailing slash on the login URL", async () => {
    const fetchImpl = makeFetch({ body: tokenBody() });
    await exchangeAuthorizationCode(
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
        error_description: "expired authorization code",
      }),
    });
    await expect(
      exchangeAuthorizationCode(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "SF_AUTH_FAILED" });
    await expect(
      exchangeAuthorizationCode(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("maps a non-JSON success body to SF_AUTH_FAILED", async () => {
    const fetchImpl = makeFetch({ body: "<html>maintenance</html>" });
    await expect(
      exchangeAuthorizationCode(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "SF_AUTH_FAILED" });
  });

  it("throws SF_AUTH_FAILED when the response omits the refresh_token", async () => {
    // A missing refresh_token means the `refresh_token` scope was not granted.
    const fetchImpl = makeFetch({
      body: tokenBody({ refresh_token: undefined }),
    });
    await expect(
      exchangeAuthorizationCode(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "SF_AUTH_FAILED" });
  });

  it("throws SF_AUTH_FAILED when the response omits access_token / instance_url / id", async () => {
    for (const missing of ["access_token", "instance_url", "id"]) {
      const fetchImpl = makeFetch({ body: tokenBody({ [missing]: undefined }) });
      await expect(
        exchangeAuthorizationCode(VALID_INPUT, {
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
      exchangeAuthorizationCode(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "SF_NETWORK_TIMEOUT" });
  });

  it("never echoes the code, code_verifier, or client_secret in error messages", async () => {
    const httpFail = makeFetch({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    });
    const netFail = vi.fn(async () => {
      throw new Error("connection reset");
    });

    for (const fetchImpl of [httpFail, netFail]) {
      const err = await exchangeAuthorizationCode(VALID_INPUT, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).then(
        () => {
          throw new Error("expected a rejection");
        },
        (e: unknown) => e as Error,
      );
      expect(err.message).not.toContain(VALID_INPUT.code);
      expect(err.message).not.toContain(VALID_INPUT.codeVerifier);
      expect(err.message).not.toContain(VALID_INPUT.clientSecret);
    }
  });
});
