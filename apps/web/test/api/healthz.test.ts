// P3C-03 — `/healthz` route handler (API §E-34 / §7.9.1). The contract is
// load-bearing for the desktop iframe surface's 5-second heartbeat — a
// regression in the response shape, status, or `Cache-Control` header would
// silently turn the banner permanently on or permanently off depending on the
// failure mode.

import { describe, expect, it } from "vitest";

import { GET } from "../../app/healthz/route";

describe("GET /healthz", () => {
  it("returns 200 with {status: 'ok'} body (liveness contract)", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ status: "ok" });
  });

  it("sets Cache-Control: no-cache (API §6.8 ALB cluster table)", () => {
    const res = GET();
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("returns JSON content type", () => {
    const res = GET();
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
