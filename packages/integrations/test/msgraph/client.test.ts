import { describe, expect, it, vi } from "vitest";

import { MSGraphClient, MsGraphError } from "../../src/msgraph/client.js";
import { msGraphAvailable, resolveMsGraphCredentials } from "../../src/msgraph/capability.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ENV_WITH = {
  MS_TENANT_ID: "tenant-1",
  MS_GRAPH_CLIENT_ID: "client-1",
  MS_GRAPH_CLIENT_SECRET: "secret-1",
} as unknown as NodeJS.ProcessEnv;

const ENV_WITHOUT = {} as unknown as NodeJS.ProcessEnv;

function liveClient(fetchImpl: typeof fetch): MSGraphClient {
  return new MSGraphClient({
    credentials: { tenantId: "t", clientId: "c", clientSecret: "s" },
    fetchImpl,
    getToken: () => Promise.resolve("FAKE_GRAPH_TOKEN"),
  });
}

describe("MS Graph capability", () => {
  it("resolves credentials only when all three vars are present", () => {
    expect(resolveMsGraphCredentials(ENV_WITH)).not.toBeNull();
    expect(resolveMsGraphCredentials(ENV_WITHOUT)).toBeNull();
    expect(msGraphAvailable(ENV_WITH)).toBe(true);
    expect(msGraphAvailable(ENV_WITHOUT)).toBe(false);
  });

  it("fromEnv returns null (degraded) when creds are absent", () => {
    expect(MSGraphClient.fromEnv(ENV_WITHOUT)).toBeNull();
    expect(MSGraphClient.fromEnv(ENV_WITH)).toBeInstanceOf(MSGraphClient);
  });
});

describe("MSGraphClient.createInvite", () => {
  it("POSTs to /users/{organizer}/events and returns the event id; attendees in body not URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "AAMkAGEvent123" }),
    ) as unknown as typeof fetch;
    const client = liveClient(fetchImpl);

    const result = await client.createInvite({
      organizerMailbox: "specialist@anthoshome.org",
      subject: "Stability visit",
      startUtc: "2026-06-10T15:00:00.000Z",
      endUtc: "2026-06-10T15:30:00.000Z",
      attendeeEmails: ["participant@example.org"],
    });

    expect(result.outlookEventId).toBe("AAMkAGEvent123");
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe(
      "https://graph.microsoft.com/v1.0/users/specialist%40anthoshome.org/events",
    );
    // PII firewall: the participant email is in the body, never the URL.
    expect(String(url)).not.toContain("participant@example.org");
    expect(init?.method).toBe("POST");
    expect(init?.body as string).toContain("participant@example.org");
  });

  it("maps a 401 to GRAPH_AUTH_FAILED and never echoes the body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "attendee leak participant@example.org" } }, 401),
    ) as unknown as typeof fetch;
    const client = liveClient(fetchImpl);
    await expect(
      client.createInvite({
        organizerMailbox: "s@x.org",
        subject: "v",
        startUtc: "2026-06-10T15:00:00.000Z",
        endUtc: "2026-06-10T15:30:00.000Z",
        attendeeEmails: ["p@example.org"],
      }),
    ).rejects.toMatchObject({ code: "GRAPH_AUTH_FAILED" });
  });

  it("cancelInvite POSTs to the /cancel action", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    const client = liveClient(fetchImpl);
    await client.cancelInvite("s@x.org", "EVT1", "rescheduling");
    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe(
      "https://graph.microsoft.com/v1.0/users/s%40x.org/events/EVT1/cancel",
    );
  });

  it("surfaces a timeout as GRAPH_NETWORK_TIMEOUT", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const client = liveClient(fetchImpl);
    await expect(
      client.cancelInvite("s@x.org", "EVT1"),
    ).rejects.toBeInstanceOf(MsGraphError);
  });
});
