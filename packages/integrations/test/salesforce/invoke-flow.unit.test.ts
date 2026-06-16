import { describe, expect, it, vi } from "vitest";

import { SalesforceRestClient } from "../../src/salesforce/rest-client.js";
import { SalesforceError, type SalesforceAuth } from "../../src/salesforce/types.js";

const STATIC_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("FAKE_TOKEN"),
  getInstanceUrl: () => Promise.resolve("https://fake.my.salesforce.com"),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch): SalesforceRestClient {
  return new SalesforceRestClient({ auth: STATIC_AUTH, fetchImpl });
}

describe("SalesforceRestClient.invokeFlow", () => {
  it("POSTs to /actions/custom/flow/{name} wrapping inputs as { inputs: [..] }", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { isSuccess: true, outputValues: { activityId: "00T5g00000XyzAAA" }, errors: null },
      ]),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    const result = await client.invokeFlow("Anthos_Send_Email", {
      participant_id: "a015g00000ABCDxQAO",
      subject: "Hello",
      body: "<p>Hi</p>",
    });

    expect(result.isSuccess).toBe(true);
    expect(result.outputValues.activityId).toBe("00T5g00000XyzAAA");

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe(
      "https://fake.my.salesforce.com/services/data/v67.0/actions/custom/flow/Anthos_Send_Email",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      inputs: [
        { participant_id: "a015g00000ABCDxQAO", subject: "Hello", body: "<p>Hi</p>" },
      ],
    });
  });

  it("maps a non-success Flow result to SF_VALIDATION_FAILED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          isSuccess: false,
          outputValues: {},
          errors: [{ statusCode: "INVALID_INPUT", message: "missing recipient" }],
        },
      ]),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    await expect(
      client.invokeFlow("Anthos_Send_Email", { participant_id: "x" }),
    ).rejects.toMatchObject({ code: "SF_VALIDATION_FAILED" });
  });

  it("rejects an invalid flow identifier (URL injection guard)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.invokeFlow("bad/name", { x: 1 }),
    ).rejects.toBeInstanceOf(SalesforceError);
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("throws SF_UNKNOWN when the actions API returns an empty array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.invokeFlow("Anthos_Send_Email", { x: 1 }),
    ).rejects.toMatchObject({ code: "SF_UNKNOWN" });
  });
});
