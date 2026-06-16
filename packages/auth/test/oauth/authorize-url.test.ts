import { describe, expect, it } from "vitest";

import { buildAuthorizeUrl } from "../../src/oauth/authorize-url.js";
import type { AuthorizeUrlParams } from "../../src/oauth/authorize-url.js";

const PARAMS: AuthorizeUrlParams = {
  loginUrl: "https://example.my.salesforce.com",
  clientId: "client-abc",
  redirectUri: "https://bff.test/api/v1/auth/callback",
  codeChallenge: "challenge-xyz",
  state: "state-123",
  scope: "api refresh_token",
};

describe("buildAuthorizeUrl (RFC 6749 §4.1.1 + RFC 7636)", () => {
  it("targets the Salesforce authorize endpoint", () => {
    const url = new URL(buildAuthorizeUrl(PARAMS));
    expect(url.origin).toBe("https://example.my.salesforce.com");
    expect(url.pathname).toBe("/services/oauth2/authorize");
  });

  it("carries response_type=code and code_challenge_method=S256", () => {
    const q = new URL(buildAuthorizeUrl(PARAMS)).searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
  });

  it("carries every caller-supplied param, decodable back to the input", () => {
    const q = new URL(buildAuthorizeUrl(PARAMS)).searchParams;
    expect(q.get("client_id")).toBe(PARAMS.clientId);
    expect(q.get("redirect_uri")).toBe(PARAMS.redirectUri);
    expect(q.get("code_challenge")).toBe(PARAMS.codeChallenge);
    expect(q.get("state")).toBe(PARAMS.state);
    expect(q.get("scope")).toBe(PARAMS.scope);
  });

  it("does not double the slash when loginUrl has a trailing slash", () => {
    const url = buildAuthorizeUrl({
      ...PARAMS,
      loginUrl: "https://example.my.salesforce.com/",
    });
    expect(url).toContain("/services/oauth2/authorize");
    expect(url).not.toContain("com//services");
  });

  it("URL-encodes the space in a multi-token scope", () => {
    const raw = buildAuthorizeUrl(PARAMS);
    expect(raw).not.toContain("api refresh_token"); // a literal space never appears
    expect(new URL(raw).searchParams.get("scope")).toBe("api refresh_token");
  });
});
