import { describe, expect, it } from "vitest";

import { hydrateCaseload } from "../../src/salesforce/bulk-hydration.js";
import { SfCliKeychainAuth } from "../../src/salesforce/auth.js";
import { SalesforceError } from "../../src/salesforce/types.js";

// Opt-in live-sandbox test. Default-skipped in CI to keep the test pyramid
// hermetic (per impl plan v1.4 §6.2). The exact env var names + the
// anonymized-sandbox owner Id to use are documented below.
//
// Requires:
//   - `sf` CLI logged into alias `anthos-demo` (or override with SF_DEMO_ORG_ALIAS)
//   - SF_BULK_HYDRATION_OWNER_ID set to a real `Aftercare_Owner__c` User Id
//     (a specialist who has in-aftercare Program Enrollments on the sandbox).
//     NOTE — this changed in P0-08d: the caseload is now keyed by
//     `Aftercare_Owner__c`, not the record `OwnerId`.
//
// What this test guards: P0-08 shipped an adapter whose SOQL named columns
// the live schema does not have (`Status__c`, `IDW_Case_Note__c` fields,
// `Incident__c.Program_Enrollment__c`). The regression this test catches is a
// `No such column` (INVALID_FIELD) rejection — so it MUST fail, not skip, on
// SF_QUERY_INVALID / SF_FIELD_FLS_DENIED. Only a local `sf`-CLI auth failure
// is skippable (an environment problem, not a code problem).
//
// The `anthos-demo` sandbox has 0 rows in `Barriers__c` / `Incident__c` /
// `Incident_Participant__c` (Erick curated only PE data). So this test
// verifies query *acceptance* + a non-empty parent result; sibling row
// *content* is exercised by the unit tests against synthetic fixtures.

const ENABLED = process.env.RUN_SF_SANDBOX_TESTS === "1";
const OWNER_ID = process.env.SF_BULK_HYDRATION_OWNER_ID ?? "";
const ORG_ALIAS = process.env.SF_DEMO_ORG_ALIAS ?? "anthos-demo";
const PII_SENSITIVE_KEYS = [
  "Birthdate",
  "Phone",
  "MobilePhone",
  "Email",
  "MailingStreet",
  "MailingCity",
  "MailingPostalCode",
  "SSN__c",
  "CIN__c",
];

describe.skipIf(!ENABLED)("hydrateCaseload — live sandbox (opt-in)", () => {
  it("queries a specialist's caseload against the live anthos-demo schema", async () => {
    if (!OWNER_ID) {
      throw new Error(
        "SF_BULK_HYDRATION_OWNER_ID (an Aftercare_Owner__c User Id) must be set when RUN_SF_SANDBOX_TESTS=1",
      );
    }
    const auth = new SfCliKeychainAuth({ orgAlias: ORG_ALIAS });

    let result;
    try {
      result = await hydrateCaseload(OWNER_ID, { auth });
    } catch (err) {
      if (err instanceof SalesforceError && err.code === "SF_AUTH_FAILED") {
        // Local `sf` CLI install has plugin-load errors (common on macOS
        // Homebrew installs missing @oclif/plugin-command-snapshot or
        // @salesforce/plugin-release-management). Re-run from a clean shell
        // or `sf plugins install`. Skip — the adapter contract is exercised
        // by the unit tests. Every OTHER SalesforceError is a real failure:
        // SF_QUERY_INVALID / SF_FIELD_FLS_DENIED is exactly the P0-08d
        // regression and must fail this test, not skip it.
        console.warn(`[P0-08d integration test] sf CLI auth failed locally: ${err.message}`);
        return;
      }
      throw err;
    }

    // The parent query returns real PE rows — the round-1 SOQL is accepted.
    expect(result.snapshots.length).toBeGreaterThan(0);
    // Parent query + one composite/batch call. TR-SF-2.
    expect(result.roundTrips).toBeLessThanOrEqual(2);

    const sfIdPattern = /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/;
    for (const snapshot of result.snapshots.slice(0, 3)) {
      expect(snapshot.participantId).toMatch(sfIdPattern);
      // ownerId is the Aftercare_Owner__c the round-1 query filtered on.
      expect(snapshot.ownerId).toBe(OWNER_ID);
      // Sibling collections are accepted queries; on the curated sandbox they
      // come back empty (0 Barrier / Incident rows). Assert shape, not size.
      expect(Array.isArray(snapshot.barriers)).toBe(true);
      expect(Array.isArray(snapshot.incidents)).toBe(true);
    }

    // PII firewall — defense-in-depth even on the anonymized sandbox.
    const serialized = JSON.stringify(result.snapshots);
    for (const sensitive of PII_SENSITIVE_KEYS) {
      expect(serialized).not.toContain(`"${sensitive}"`);
    }

    console.warn(
      `[P0-08d cost validation] caseload=${result.snapshots.length} round_trips=${result.roundTrips}`,
    );
  }, 30_000);
});
