import { describe, expect, it, vi } from "vitest";

import { EmailFlowClient } from "../../src/email/flow-client.js";
import type { SalesforceRestClient } from "../../src/salesforce/rest-client.js";
import { SalesforceError } from "../../src/salesforce/types.js";

function makeRestClient(
  invokeImpl: (flow: string, inputs: Record<string, unknown>) => Promise<{
    isSuccess: boolean;
    outputValues: Record<string, unknown>;
    errors: ReadonlyArray<{ statusCode?: string; message?: string }> | null;
  }>,
) {
  const invokeFlow = vi.fn(invokeImpl);
  const client = { invokeFlow } as unknown as SalesforceRestClient;
  return { client, invokeFlow };
}

const ARGS = {
  participantId: "a015g00000ABCDxQAO",
  subject: "Your stability visit",
  bodyHtml: "<p>See you Tuesday.</p>",
  templateKey: "checkin",
};

describe("EmailFlowClient.send", () => {
  it("invokes the configured flow with TRD input names and returns the activity id", async () => {
    const { client, invokeFlow } = makeRestClient(async () => ({
      isSuccess: true,
      outputValues: { activityId: "00T5g00000XyzAAA" },
      errors: null,
    }));
    const email = new EmailFlowClient({ restClient: client, flowApiName: "Anthos_Send_Email" });

    const result = await email.send(ARGS);

    const [flow, inputs] = invokeFlow.mock.calls[0]!;
    expect(flow).toBe("Anthos_Send_Email");
    expect(inputs).toEqual({
      participant_id: ARGS.participantId,
      subject: ARGS.subject,
      body: ARGS.bodyHtml,
      template_id: "checkin",
    });
    expect(result).toEqual({ emailId: "00T5g00000XyzAAA", activityId: "00T5g00000XyzAAA" });
  });

  it("accepts alternate output-id variable names (TBD-tolerant)", async () => {
    const { client } = makeRestClient(async () => ({
      isSuccess: true,
      outputValues: { recordId: "00T5g00000ZZZAAA" },
      errors: null,
    }));
    const email = new EmailFlowClient({ restClient: client, flowApiName: "F" });
    const result = await email.send(ARGS);
    expect(result.activityId).toBe("00T5g00000ZZZAAA");
  });

  it("throws SF_UNKNOWN when the flow returns no recognizable record id", async () => {
    const { client } = makeRestClient(async () => ({
      isSuccess: true,
      outputValues: { somethingElse: true },
      errors: null,
    }));
    const email = new EmailFlowClient({ restClient: client, flowApiName: "F" });
    await expect(email.send(ARGS)).rejects.toMatchObject({ code: "SF_UNKNOWN" });
  });

  it("propagates a SalesforceError from invokeFlow", async () => {
    const { client } = makeRestClient(async () => {
      throw new SalesforceError("SF_VALIDATION_FAILED", "flow rejected inputs");
    });
    const email = new EmailFlowClient({ restClient: client, flowApiName: "F" });
    await expect(email.send(ARGS)).rejects.toBeInstanceOf(SalesforceError);
  });
});
