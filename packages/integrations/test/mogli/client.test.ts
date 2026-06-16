import { describe, expect, it, vi } from "vitest";

import { MogliClient } from "../../src/mogli/client.js";
import type { SalesforceRestClient } from "../../src/salesforce/rest-client.js";
import { SalesforceError } from "../../src/salesforce/types.js";

function makeRestClient(
  createImpl: (sobject: string, fields: Record<string, unknown>) => Promise<{
    id: string;
    success: boolean;
    errors: unknown[];
  }>,
) {
  const createRecord = vi.fn(createImpl);
  const client = { createRecord } as unknown as SalesforceRestClient;
  return { client, createRecord };
}

const BASE_ARGS = {
  phoneNumber: "+12125550123",
  message: "Reminder: your stability visit is Tuesday.",
  contactId: "0035g00000ABCDxQAO",
  programEnrollmentId: "a1kU800000pjn4WIAQ",
  gatewayId: "a3kU80000018tpxIAA",
};

describe("MogliClient.sendSms", () => {
  it("inserts an outgoing Mogli_SMS__SMS__c with the verified field shape", async () => {
    const { client, createRecord } = makeRestClient(async () => ({
      id: "a40U80000021uF7IAI",
      success: true,
      errors: [],
    }));
    const mogli = new MogliClient({ restClient: client });

    const result = await mogli.sendSms(BASE_ARGS);

    expect(createRecord).toHaveBeenCalledTimes(1);
    const [sobject, fields] = createRecord.mock.calls[0]!;
    expect(sobject).toBe("Mogli_SMS__SMS__c");
    expect(fields).toMatchObject({
      Mogli_SMS__Phone_Number__c: BASE_ARGS.phoneNumber,
      Mogli_SMS__Message__c: BASE_ARGS.message,
      Mogli_SMS__Contact__c: BASE_ARGS.contactId,
      Program_Enrollment__c: BASE_ARGS.programEnrollmentId,
      Mogli_SMS__Gateway__c: BASE_ARGS.gatewayId,
      Mogli_SMS__Direction__c: "Outgoing",
    });
    // The managed trigger owns Status — the adapter must not set it.
    expect(fields).not.toHaveProperty("Mogli_SMS__Status__c");
    // No scheduled delivery on an immediate send.
    expect(fields).not.toHaveProperty("Mogli_SMS__Scheduled_Delivery__c");
    expect(result).toEqual({
      smsId: "a40U80000021uF7IAI",
      mogliMessageId: "a40U80000021uF7IAI",
      deliveryStatus: "queued",
    });
  });

  it("sets Scheduled_Delivery and returns 'scheduled' when a future time is given", async () => {
    const { client, createRecord } = makeRestClient(async () => ({
      id: "a40U80000021uF8IAI",
      success: true,
      errors: [],
    }));
    const mogli = new MogliClient({ restClient: client });

    const result = await mogli.sendSms({
      ...BASE_ARGS,
      scheduledDelivery: "2026-05-22T12:00:00.000Z",
    });

    const [, fields] = createRecord.mock.calls[0]!;
    expect(fields).toMatchObject({
      Mogli_SMS__Scheduled_Delivery__c: "2026-05-22T12:00:00.000Z",
    });
    expect(result.deliveryStatus).toBe("scheduled");
  });

  it("propagates a SalesforceError from the insert", async () => {
    const { client } = makeRestClient(async () => {
      throw new SalesforceError("SF_FIELD_FLS_DENIED", "no create on SMS");
    });
    const mogli = new MogliClient({ restClient: client });
    await expect(mogli.sendSms(BASE_ARGS)).rejects.toBeInstanceOf(SalesforceError);
  });
});
