import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

// `next.config.ts` `headers()` is the single place the CSP `frame-ancestors`
// header is wired (TR-AUTH-5, P1B-06). These assertions lock the contract:
// the header reaches every route, and `X-Frame-Options` is never set.

describe("next.config headers() — CSP frame-ancestors (TR-AUTH-5)", () => {
  it("sets Content-Security-Policy: frame-ancestors on every route", async () => {
    const headers = await nextConfig.headers?.();
    expect(headers).toBeDefined();

    const entry = headers?.find((rule) => rule.source === "/:path*");
    expect(entry).toBeDefined();

    const csp = entry?.headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toMatch(/^frame-ancestors\s+\S/);
  });

  it("never sets X-Frame-Options — TR-AUTH-5: it MUST NOT be used", async () => {
    const headers = (await nextConfig.headers?.()) ?? [];
    const allKeys = headers.flatMap((rule) =>
      rule.headers.map((h) => h.key.toLowerCase()),
    );
    expect(allKeys).not.toContain("x-frame-options");
  });
});
