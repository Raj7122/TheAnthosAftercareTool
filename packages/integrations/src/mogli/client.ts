// MogliClient — outbound SMS adapter (F-09 / E-11). Mogli is the SoR-adjacent
// SMS vendor; in Salesforce a send is represented by a `Mogli_SMS__SMS__c`
// record whose insert triggers Mogli's managed gateway to deliver the message.
//
// Demo Mode write path: this adapter inserts the `Mogli_SMS__SMS__c` record
// directly via the SalesforceRestClient (the same DML primitive the Log-a-Call
// endpoint uses). That is production-SHAPE: in the deployed org a registered
// gateway picks the record up and delivers it; in `anthoshome3--pursuit` only a
// "Dummy Gateway" exists, so the record enqueues but is not delivered. The
// caller (and the handler above it) never knows whether delivery is live — the
// seam is the gateway, not this adapter. A later swap to Mogli's REST API
// (MogliAPI_Settings + the "Mogli API Authorization" flow) is a substitution
// behind `sendSms` with no caller change.
//
// Field names verified live against `Mogli_SMS__SMS__c` in the sandbox
// (2026-06-03): Direction picklist value is "Outgoing"; the managed trigger
// sets `Mogli_SMS__Status__c` on insert, so this adapter does NOT set it.

import { SalesforceError } from "../salesforce/types.js";
import type { SalesforceRestClient } from "../salesforce/rest-client.js";

const SMS_SOBJECT = "Mogli_SMS__SMS__c";

// Outbound direction picklist value (verified: the object uses "Outgoing",
// not "Outbound").
const DIRECTION_OUTGOING = "Outgoing";

export interface SendSmsArgs {
  // Recipient phone, E.164 preferred (Mogli_SMS__Phone_Number__c).
  readonly phoneNumber: string;
  // Message body (Mogli_SMS__Message__c). The caller owns content; this adapter
  // never logs or echoes it (PII firewall posture).
  readonly message: string;
  // Participant's Contact Id (Mogli_SMS__Contact__c lookup).
  readonly contactId: string;
  // Program Enrollment Id (Program_Enrollment__c custom lookup) — links the SMS
  // to the participant's enrollment for the timeline / "most recent contact".
  readonly programEnrollmentId: string;
  // Gateway record Id (Mogli_SMS__Gateway__c). In Demo this is the Dummy Gateway.
  readonly gatewayId: string;
  // Optional scheduled-delivery instant (Mogli_SMS__Scheduled_Delivery__c, ISO).
  // Used by the quiet-hours "schedule for the next allowed window" path.
  readonly scheduledDelivery?: string;
}

export interface SendSmsResult {
  // The created `Mogli_SMS__SMS__c` record Id — doubles as the Mogli message id
  // for Demo (the SF record IS the message in the managed-package model).
  readonly smsId: string;
  readonly mogliMessageId: string;
  // Initial delivery status surfaced to the caller. The managed trigger owns
  // the authoritative status asynchronously; on insert the message is enqueued
  // for the gateway, so the optimistic initial status is "queued" (or
  // "scheduled" when a future delivery time was set).
  readonly deliveryStatus: "queued" | "scheduled";
}

export interface MogliClientOptions {
  readonly restClient: SalesforceRestClient;
}

export class MogliClient {
  private readonly restClient: SalesforceRestClient;

  constructor(options: MogliClientOptions) {
    this.restClient = options.restClient;
  }

  // Inserts an outbound SMS record. Salesforce DML / FLS / validation failures
  // surface as the adapter's structured `SalesforceError` (mapped by the REST
  // client) so the handler can render them exactly as the Case-Note path does.
  async sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
    const fields: Record<string, unknown> = {
      Mogli_SMS__Phone_Number__c: args.phoneNumber,
      Mogli_SMS__Message__c: args.message,
      Mogli_SMS__Contact__c: args.contactId,
      Program_Enrollment__c: args.programEnrollmentId,
      Mogli_SMS__Gateway__c: args.gatewayId,
      Mogli_SMS__Direction__c: DIRECTION_OUTGOING,
    };
    if (args.scheduledDelivery !== undefined) {
      fields.Mogli_SMS__Scheduled_Delivery__c = args.scheduledDelivery;
    }

    const created = await this.restClient.createRecord(SMS_SOBJECT, fields);
    // `createRecord` already throws on `success !== true` / empty id; this
    // belt-and-braces guard keeps the success contract explicit at the adapter
    // boundary.
    if (created.id.length === 0) {
      throw new SalesforceError(
        "SF_UNKNOWN",
        "Mogli SMS insert returned an empty record id",
      );
    }
    return {
      smsId: created.id,
      mogliMessageId: created.id,
      deliveryStatus: args.scheduledDelivery !== undefined ? "scheduled" : "queued",
    };
  }
}
