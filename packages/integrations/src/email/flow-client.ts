// EmailFlowClient — outbound participant email via a tool-owned Salesforce Flow
// (F-10 / E-12). Per TRD v1.9 §: "Outbound emails MUST be sent by invoking a
// dedicated tool-owned Salesforce Flow via REST
// (`POST /services/data/{v}/actions/custom/flow/{FlowApiName}`). The Flow
// performs the Salesforce-native send and creates the EmailMessage / Activity
// record intrinsically — no BCC-to-Salesforce pattern." The Flow accepts
// `(participant_id, subject, body, template_id)` as inputs.
//
// Status: the tool-owned Flow is NOT yet deployed to `anthoshome3--pursuit`.
// This adapter is therefore correct-but-dark: it invokes `flowApiName` from
// config, and lights up the moment the autolaunched Flow exists. The Flow's
// output-variable name for the created record id is [TBD] (depends on how the
// Flow is authored), so we extract it tolerantly from `outputValues`.
//
// (GAP-8, resolved) Only AUTOLAUNCHED flows are REST-invocable — the tool-owned
// email Flow must be autolaunched, not a screen flow.

import { SalesforceError } from "../salesforce/types.js";
import type { SalesforceRestClient } from "../salesforce/rest-client.js";

export interface SendEmailArgs {
  // Participant link — the Program Enrollment id (the Flow resolves the
  // recipient Contact / email from it server-side; the tool never sends a raw
  // address as an input).
  readonly participantId: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly templateKey?: string;
}

export interface SendEmailResult {
  // The created Activity / EmailMessage record id, surfaced from the Flow's
  // output variables. `emailId` and `activityId` are the same record for Demo
  // (the Flow creates one Activity); kept as two fields to match the E-12 wire.
  readonly emailId: string;
  readonly activityId: string;
}

export interface EmailFlowClientOptions {
  readonly restClient: SalesforceRestClient;
  // Tool-owned autolaunched Flow API name. Sourced from config/env by the
  // caller; when absent the caller must refuse the send (email-not-configured)
  // rather than constructing this client.
  readonly flowApiName: string;
}

// Candidate output-variable names the Flow might use for the created record id.
// [TBD] — narrows to one once the Flow is authored; until then we accept any of
// these so wiring the real Flow needs no adapter change.
const OUTPUT_ID_KEYS = [
  "activityId",
  "emailMessageId",
  "recordId",
  "taskId",
  "outputRecordId",
] as const;

function extractRecordId(outputValues: Record<string, unknown>): string | null {
  for (const key of OUTPUT_ID_KEYS) {
    // `key` iterates a hardcoded literal allowlist (OUTPUT_ID_KEYS), not user
    // input — the object-injection heuristic is a false positive here.
    // eslint-disable-next-line security/detect-object-injection
    const value = outputValues[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export class EmailFlowClient {
  private readonly restClient: SalesforceRestClient;
  private readonly flowApiName: string;

  constructor(options: EmailFlowClientOptions) {
    this.restClient = options.restClient;
    this.flowApiName = options.flowApiName;
  }

  async send(args: SendEmailArgs): Promise<SendEmailResult> {
    const inputs: Record<string, unknown> = {
      participant_id: args.participantId,
      subject: args.subject,
      body: args.bodyHtml,
      ...(args.templateKey !== undefined ? { template_id: args.templateKey } : {}),
    };
    const result = await this.restClient.invokeFlow(this.flowApiName, inputs);
    const activityId = extractRecordId(result.outputValues);
    if (activityId === null) {
      // The Flow succeeded but did not return a record id under any known
      // output name — surface loud rather than synthesize an id (no
      // silent catches). Re-map the Flow output key once it is known.
      throw new SalesforceError(
        "SF_UNKNOWN",
        "Email Flow succeeded but returned no recognizable record id output",
      );
    }
    return { emailId: activityId, activityId };
  }
}
