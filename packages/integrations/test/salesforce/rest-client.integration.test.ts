import { describe, expect, it } from "vitest";

import { SalesforceRestClient } from "../../src/salesforce/rest-client.js";
import { SfCliKeychainAuth } from "../../src/salesforce/auth.js";

// Opt-in live-sandbox test for `createRecord` (P1E-01). Default-skipped to
// keep CI hermetic; mirrors the bulk-hydration integration test gating.
//
// What this guards: the DML write path actually negotiates with the live
// `anthos-demo` schema (POST /sobjects/Barriers__c/, the new sobject-
// identifier guard, the DML error mappings). Creates one Barrier on a known
// in-aftercare PE then deletes it via REST. A REQUIRED_FIELD_MISSING probe
// verifies the new SF_VALIDATION_FAILED error mapping end-to-end.
//
// Requires:
//   - `sf` CLI logged into alias `anthos-demo` (or override with SF_DEMO_ORG_ALIAS)
//   - SF_INTEGRATION_TEST_PE_ID — a real IDW_Program_Enrollment__c Id whose
//     RecordType allows Barriers (any in-aftercare PE works).

const ENABLED = process.env.RUN_SF_SANDBOX_TESTS === "1";
const TEST_PE_ID = process.env.SF_INTEGRATION_TEST_PE_ID ?? "";
const ORG_ALIAS = process.env.SF_DEMO_ORG_ALIAS ?? "anthos-demo";

describe.skipIf(!ENABLED)(
  "SalesforceRestClient.createRecord — live sandbox (opt-in)",
  () => {
    it("creates and deletes a Barriers__c row", async () => {
      if (!TEST_PE_ID) {
        throw new Error(
          "SF_INTEGRATION_TEST_PE_ID must be set when RUN_SF_SANDBOX_TESTS=1",
        );
      }
      const auth = new SfCliKeychainAuth({ orgAlias: ORG_ALIAS });
      const client = new SalesforceRestClient({ auth });

      const today = new Date().toISOString().replace(/T.*$/, "");
      const created = await client.createRecord("Barriers__c", {
        Type__c: "PA issue",
        Stage__c: "Aftercare",
        Start_Date__c: today,
        Program_Enrollment__c: TEST_PE_ID,
        Description__c: "[P1E-01 integration test — safe to delete]",
      });
      expect(created.success).toBe(true);
      expect(created.id).toMatch(/^a0K/);

      // Cleanup — DELETE the test record. A failure here leaks a row in the
      // sandbox but does NOT fail the test (the create-side contract is what
      // this test guards).
      try {
        const accessToken = await auth.getAccessToken();
        const instanceUrl = await auth.getInstanceUrl();
        const del = await fetch(
          `${instanceUrl}/services/data/v67.0/sobjects/Barriers__c/${created.id}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        expect(del.ok || del.status === 404).toBe(true);
      } catch (err) {
        // Surface the cleanup failure on the log; do not fail the test.
        console.warn(
          `[P1E-01] cleanup of ${created.id} failed: ${(err as Error).message}`,
        );
      }
    });

    it("maps REQUIRED_FIELD_MISSING to SF_VALIDATION_FAILED", async () => {
      const auth = new SfCliKeychainAuth({ orgAlias: ORG_ALIAS });
      const client = new SalesforceRestClient({ auth });
      // Omit Program_Enrollment__c (required master-detail) — SF should reject.
      await expect(
        client.createRecord("Barriers__c", { Type__c: "PA issue" }),
      ).rejects.toMatchObject({ code: "SF_VALIDATION_FAILED" });
    });
  },
);
