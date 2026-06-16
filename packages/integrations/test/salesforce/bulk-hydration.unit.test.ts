import { describe, expect, it, vi } from "vitest";

import { hydrateCaseload } from "../../src/salesforce/bulk-hydration.js";
import { SalesforceError, type SalesforceAuth } from "../../src/salesforce/types.js";
import {
  EMPTY_ENROLLMENT_RESPONSE,
  SYNTHETIC_COMPOSITE_BATCH_RESPONSE,
  SYNTHETIC_ENROLLMENT_RESPONSE,
  SYNTHETIC_OWNER_ID,
} from "./_fixtures/caseload-response.js";

const STATIC_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("FAKE_TOKEN"),
  getInstanceUrl: () => Promise.resolve("https://fake.my.salesforce.com"),
};

const FROZEN_NOW = new Date("2026-05-18T12:00:00Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchSequence(responses: ReadonlyArray<Response>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    if (r === undefined) {
      throw new Error(`makeFetchSequence: no response queued for call ${i}`);
    }
    return r;
  }) as unknown as typeof fetch;
}

describe("hydrateCaseload — adapter mapping", () => {
  it("maps an enrollment + composite batch response into 3 CaseloadSnapshots", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);

    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });

    expect(result.snapshots).toHaveLength(3);
    expect(result.roundTrips).toBe(2);
    expect(result.hydratedAt).toEqual(FROZEN_NOW);

    const first = result.snapshots[0]!;
    expect(first.participantId).toBe("a1kU800000pjmA1IAI");
    expect(first.ownerId).toBe(SYNTHETIC_OWNER_ID);
    expect(first.enrollment.aftercareOwnerId).toBe(SYNTHETIC_OWNER_ID);
    expect(first.enrollment.aftercareExtended).toBe(true);
    expect(first.enrollment.mostRecentSuccessfulContact).toEqual(new Date("2026-04-01"));
    expect(first.enrollment.dueDates.upcoming).toEqual(new Date("2026-05-15"));
    expect(first.enrollment.voucherRecertDeadline).toEqual(new Date("2026-09-01"));
    // BR-19(c) failed_attempts source — raw PE check-in rollup counts.
    expect(first.enrollment.checkInsAttempted).toBe(3);
    expect(first.enrollment.checkInsCompleted).toBe(8);
    expect(first.enrollment.missedCheckIns).toBe(1);

    expect(first.barriers).toHaveLength(1);
    expect(first.barriers[0]!.type).toBe("Cannot reach participant");

    // Incidents come through the Incident_Participant__c junction: ip1 + ip4
    // both link CONTACT_A1.
    expect(first.incidents).toHaveLength(2);
    expect(first.incidents[0]!.id).toBe("a0cU8000000I1IAQ");
    expect(first.incidents[0]!.incidentType).toBe("Medical");
    expect(first.incidents[0]!.incidentDate).toEqual(
      new Date("2026-04-25T14:30:00.000+0000"),
    );
    expect(first.incidents[0]!.critical).toBe(true);
    // ip4 — Incident type + critical flag unset: per-field null coercion.
    expect(first.incidents[1]!.id).toBe("a0cU8000000I4IAQ");
    expect(first.incidents[1]!.incidentType).toBeNull();
    expect(first.incidents[1]!.status).toBe("Open");
    expect(first.incidents[1]!.incidentDate).toEqual(
      new Date("2026-05-05T08:15:00.000+0000"),
    );
    expect(first.incidents[1]!.critical).toBe(false);
  });

  it("treats null Most_Recent_Successful_Contact__c as null (BR-15 default lives in engine)", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const second = result.snapshots[1]!;
    expect(second.enrollment.mostRecentSuccessfulContact).toBeNull();
  });

  it("treats null check-in rollup counts as null", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const third = result.snapshots[2]!;
    expect(third.enrollment.checkInsAttempted).toBeNull();
    expect(third.enrollment.checkInsCompleted).toBeNull();
    expect(third.enrollment.missedCheckIns).toBeNull();
  });

  it("derives aftercareExtended = false when extension end equals base aftercare end", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const third = result.snapshots[2]!;
    expect(third.enrollment.aftercareExtensionEndDate).toEqual(new Date("2026-06-01"));
    expect(third.enrollment.aftercareEndDate).toEqual(new Date("2026-06-01"));
    expect(third.enrollment.aftercareExtended).toBe(false);
  });

  it("maps voucherRecertDeadline to null when Subsidy_Renewal_Re_Cert_Due_Date__c is null", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const third = result.snapshots[2]!;
    expect(third.enrollment.voucherRecertDeadline).toBeNull();
  });

  it("groups incidents by participant Contact, not by enrollment", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const [a1, a2, a3] = result.snapshots;
    expect(a1!.incidents).toHaveLength(2); // CONTACT_A1 — ip1 + ip4
    expect(a2!.incidents).toHaveLength(1); // CONTACT_A2 — ip2
    expect(a3!.incidents).toHaveLength(0); // CONTACT_A3 — none
  });

  it("maps Arrear__c rows into ArrearSnapshots with correct field mapping", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    // A1 has two arrears (ar1 + ar2), both keyed to its PE.
    const first = result.snapshots[0]!;
    expect(first.arrears).toHaveLength(2);
    const ar1 = first.arrears[0]!;
    expect(ar1.id).toBe("a45U8000000AR1IAQ");
    expect(ar1.programEnrollmentId).toBe("a1kU800000pjmA1IAI");
    expect(ar1.unitEngagementId).toBe("a1MU8000000UR1IAQ");
    expect(ar1.status).toBe("Under Review");
    expect(ar1.purpose).toBe("Tenant Share");
    expect(ar1.dateIdentified).toEqual(new Date("2026-02-15"));
    expect(ar1.dateResolved).toBeNull();
    expect(ar1.arrearsStartDate).toEqual(new Date("2025-11-01"));
    expect(ar1.arrearsEndDate).toEqual(new Date("2026-02-01"));
    expect(ar1.estimatedAmount).toBe(2400.5);
    // 0 must be carried through, not coerced to null.
    expect(ar1.amountPaid).toBe(0);
    expect(ar1.lengthOfTimeMonths).toBe(3);
    // ar2 — resolved-with-payment; exercises the resolved-date path.
    const ar2 = first.arrears[1]!;
    expect(ar2.id).toBe("a45U8000000AR2IAQ");
    expect(ar2.status).toBe("Resolved With Anthos Payment");
    expect(ar2.dateResolved).toEqual(new Date("2025-12-20"));
    expect(ar2.unitEngagementId).toBeNull();
  });

  it("returns an empty arrears[] for a PE with no Arrear__c rows", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    // A2 has no arrears in the fixture.
    expect(result.snapshots[1]!.arrears).toEqual([]);
  });

  it("maps multiple arrears per PE, coerces null Arrear fields, and drops the orphan row", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const [a1, , a3] = result.snapshots;
    expect(a1!.arrears).toHaveLength(2); // multi-record per PE
    // A3 has a single all-null-fields arrear — per-field null coercion.
    expect(a3!.arrears).toHaveLength(1);
    const ar = a3!.arrears[0]!;
    expect(ar.status).toBe("Identified");
    expect(ar.unitEngagementId).toBeNull();
    expect(ar.dateIdentified).toBeNull();
    expect(ar.dateResolved).toBeNull();
    expect(ar.arrearsStartDate).toBeNull();
    expect(ar.arrearsEndDate).toBeNull();
    expect(ar.purpose).toBeNull();
    expect(ar.estimatedAmount).toBeNull();
    expect(ar.amountPaid).toBeNull();
    expect(ar.lengthOfTimeMonths).toBeNull();
    // 4 Arrear__c rows in the fixture; the 1 with a null Program_Enrollment__c
    // must be dropped by `groupBy` and surface on no snapshot.
    const totalArrears = result.snapshots.reduce(
      (sum, s) => sum + s.arrears.length,
      0,
    );
    expect(totalArrears).toBe(3);
  });

  it("hydrates the arrears sub-query inside the round-2 composite batch (still 2 round-trips)", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    // TR-SF-2: the arrears sub-query rides inside the same composite batch —
    // it does not add a round-trip.
    expect(result.roundTrips).toBe(2);
    expect(result.snapshots).toHaveLength(3);
  });

  it("issues an unfiltered FROM Arrear__c sub-query — PE IN-clause only, no status/date filter", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.body !== undefined && init.body !== null) {
          bodies.push(String(init.body));
        }
        return bodies.length === 0
          ? jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE)
          : jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE);
      },
    ) as unknown as typeof fetch;
    await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    // Only the round-2 composite batch is a POST with a body.
    expect(bodies).toHaveLength(1);
    const batchBody = decodeURIComponent(bodies[0]!);
    // Isolate the arrears sub-query: from `FROM Arrear__c` to the end of that
    // batch request's URL value (the next `"`). It must carry only the PE
    // IN-clause — BR-19(g) status/recency factor logic is the engine's job.
    const arrearSegment = batchBody
      .slice(batchBody.indexOf("FROM Arrear__c"))
      .split('"')[0]!;
    expect(arrearSegment).toContain("Program_Enrollment__c IN");
    expect(arrearSegment).not.toContain("Status__c");
    expect(arrearSegment).not.toContain("Date_");
    expect(arrearSegment).not.toContain("LAST_N_DAYS");
  });

  it("maps Repair__c rows into RepairSnapshots with correct field mapping", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    // A1 has two repairs (rp1 open + rp2 completed), both joined to its PE via
    // the two-hop `Unit_Rental__r.Program_Enrollment__c` path.
    const first = result.snapshots[0]!;
    expect(first.repairs).toHaveLength(2);
    const rp1 = first.repairs[0]!;
    expect(rp1.id).toBe("a5RU8000000RP1IAQ");
    expect(rp1.programEnrollmentId).toBe("a1kU800000pjmA1IAI");
    expect(rp1.status).toBe("Repairing");
    expect(rp1.preOrPostMoveIn).toBe("Post Move-In");
    expect(rp1.completedDate).toBeNull();
    expect(rp1.dueDate).toEqual(new Date("2026-05-30"));
    expect(rp1.identificationDate).toEqual(new Date("2026-04-20"));
    expect(rp1.urgency).toBe("High");
    expect(rp1.daysOverdue).toBe(12);
    // rp2 — terminal (Completed); exercises the completed-date path. 0 must be
    // carried through, not coerced to null.
    const rp2 = first.repairs[1]!;
    expect(rp2.id).toBe("a5RU8000000RP2IAQ");
    expect(rp2.status).toBe("Completed");
    expect(rp2.completedDate).toEqual(new Date("2026-03-01"));
    expect(rp2.daysOverdue).toBe(0);
  });

  it("returns an empty repairs[] for a PE with no Repair__c rows", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    // A2 has no repairs in the fixture.
    expect(result.snapshots[1]!.repairs).toEqual([]);
  });

  it("coerces null Repair fields and drops both orphan-shaped rows", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const [a1, , a3] = result.snapshots;
    expect(a1!.repairs).toHaveLength(2); // multi-record per PE
    // A3 has rp3 (Pre Move-In) + rp4 (all-null fields) — per-field null coercion.
    expect(a3!.repairs).toHaveLength(2);
    const rp4 = a3!.repairs.find((r) => r.id === "a5RU8000000RP4IAQ")!;
    expect(rp4.status).toBeNull();
    expect(rp4.preOrPostMoveIn).toBeNull();
    expect(rp4.completedDate).toBeNull();
    expect(rp4.dueDate).toBeNull();
    expect(rp4.identificationDate).toBeNull();
    expect(rp4.urgency).toBeNull();
    expect(rp4.daysOverdue).toBeNull();
    // 6 Repair__c rows in the fixture; the 2 orphan shapes (null Unit_Rental__r
    // and Unit_Rental__r with a null Program_Enrollment__c) must be dropped by
    // `groupBy` and surface on no snapshot.
    const totalRepairs = result.snapshots.reduce(
      (sum, s) => sum + s.repairs.length,
      0,
    );
    expect(totalRepairs).toBe(4);
  });

  it("hydrates the repairs sub-query inside the round-2 composite batch (still 2 round-trips)", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    // TR-SF-2: the repairs sub-query rides inside the same composite batch —
    // it does not add a round-trip.
    expect(result.roundTrips).toBe(2);
    expect(result.snapshots).toHaveLength(3);
  });

  it("issues an unfiltered FROM Repair__c sub-query — two-hop PE IN-clause only, no status/Pre-Post filter", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.body !== undefined && init.body !== null) {
          bodies.push(String(init.body));
        }
        return bodies.length === 0
          ? jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE)
          : jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE);
      },
    ) as unknown as typeof fetch;
    await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    expect(bodies).toHaveLength(1);
    const batchBody = decodeURIComponent(bodies[0]!);
    // Isolate the repairs sub-query: from `FROM Repair__c` to the end of that
    // batch request's URL value. It must carry only the two-hop PE IN-clause —
    // open-status / Pre-Post filtering is the engine's job (BR-25 invariant).
    const repairSegment = batchBody
      .slice(batchBody.indexOf("FROM Repair__c"))
      .split('"')[0]!;
    expect(repairSegment).toContain(
      "Unit_Rental__r.Program_Enrollment__c IN",
    );
    expect(repairSegment).not.toContain("Status__c");
    expect(repairSegment).not.toContain("Pre_or_Post");
    expect(repairSegment).not.toContain("LAST_N_DAYS");
  });

  it("returns empty snapshots[] when the caseload is empty (1 round-trip)", async () => {
    const fetchImpl = makeFetchSequence([jsonResponse(EMPTY_ENROLLMENT_RESPONSE)]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    expect(result.snapshots).toHaveLength(0);
    expect(result.roundTrips).toBe(1);
  });

  it("drops Incident_Participant rows with no Contact link", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const totalIncidents = result.snapshots.reduce(
      (sum, s) => sum + s.incidents.length,
      0,
    );
    // 4 junction rows in the fixture; 1 has a null Contact and must be dropped.
    expect(totalIncidents).toBe(3);
  });

  it("skips the incident sub-query when no participant has a Contact (still ≤2 round-trips)", async () => {
    const enrollmentResp = {
      totalSize: 1,
      done: true,
      records: [
        {
          attributes: { type: "IDW_Program_Enrollment__c", url: "/x/N1" },
          Id: "a1kU800000pjmN1IAI",
          Aftercare_Owner__c: SYNTHETIC_OWNER_ID,
          Most_Recent_Successful_Contact__c: null,
          Aftercare_Start_Date__c: "2025-06-01",
          Aftercare_End_Date__c: "2026-06-01",
          Aftercare_Extension_End_Date__c: null,
          Aftercare_First_Due_Date__c: null,
          Aftercare_Second_Due_Date__c: null,
          Aftercare_Third_Due_Date__c: null,
          Aftercare_Fourth_Due_Date__c: null,
          Upcoming_Aftercare_Visit_Due_Date__c: null,
          Program_Enrollment_Outcome__c: null,
          Contact__c: null,
          Account__c: null,
          Subsidy_Renewal_Re_Cert_Due_Date__c: null,
          Num_of_Aftercare_Check_Ins_Attempted__c: null,
          Number_of_Aftercare_Check_Ins_Completed__c: null,
          Number_of_Missed_Check_Ins__c: null,
        },
      ],
    };
    // Composite batch carries the barriers sub-result + the (always-present)
    // arrears and repairs sub-results — but no `IN ()` incident query.
    const barriersOnlyBatch = {
      hasErrors: false,
      results: [
        { statusCode: 200, result: { totalSize: 0, done: true, records: [] } },
        // P0-08b/P0-04e: the arrears and repairs sub-queries are unconditional
        // (PE-keyed), so they are present even when the incident sub-query is
        // skipped — arrears at index 1, repairs at index 2 here.
        { statusCode: 200, result: { totalSize: 0, done: true, records: [] } },
        { statusCode: 200, result: { totalSize: 0, done: true, records: [] } },
      ],
    };
    const fetchImpl = makeFetchSequence([
      jsonResponse(enrollmentResp),
      jsonResponse(barriersOnlyBatch),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]!.incidents).toEqual([]);
    expect(result.snapshots[0]!.arrears).toEqual([]);
    expect(result.snapshots[0]!.repairs).toEqual([]);
    expect(result.roundTrips).toBe(2);
  });

  it("P1H-01: projects peName / displayName / programCode from the parent enrollment + Contact__r", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });

    // Row 1 — Contact__r populated, single-value Client_Type__c.
    const a1 = result.snapshots[0]!.enrollment;
    expect(a1.peName).toBe("John Stone - 05/2025");
    expect(a1.displayName).toBe("John Stone");
    expect(a1.programCode).toBe("ACS");

    // Row 2 — null Contact__r (defensive projection), multi-value picklist.
    const a2 = result.snapshots[1]!.enrollment;
    expect(a2.peName).toBe("Bessie Alvarez - 9/2025");
    expect(a2.displayName).toBeNull();
    expect(a2.programCode).toBe("ACS;HHN");

    // Row 3 — null Client_Type__c passes through; GRAD-prefixed Name carried raw.
    const a3 = result.snapshots[2]!.enrollment;
    expect(a3.peName).toBe("GRAD Edna Hunt - 07/2023");
    expect(a3.displayName).toBe("Edna Hunt");
    expect(a3.programCode).toBeNull();
  });

  it("P1H-01: parent SOQL selects Name, Client_Type__c, and Contact__r.Name", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(EMPTY_ENROLLMENT_RESPONSE);
    }) as unknown as typeof fetch;
    await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const parentSoql = decodeURIComponent(urls[0]!);
    expect(parentSoql).toContain("Name");
    expect(parentSoql).toContain("Client_Type__c");
    expect(parentSoql).toContain("Contact__r.Name");
  });

  it("round-1 parent SOQL filters the live-schema caseload and never names Status__c", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(EMPTY_ENROLLMENT_RESPONSE);
    }) as unknown as typeof fetch;
    await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    const parentSoql = decodeURIComponent(urls[0]!);
    expect(parentSoql).toContain(`Aftercare_Owner__c = '${SYNTHETIC_OWNER_ID}'`);
    expect(parentSoql).toContain("RecordType.DeveloperName = 'Matching'");
    expect(parentSoql).toContain("Inactive__c = false");
    expect(parentSoql).toContain("Date_of_Withdrawal_or_Graduation__c = null");
    expect(parentSoql).not.toContain("Status__c");
  });

  it("rejects an ownerId that is not a Salesforce Id", async () => {
    const fetchImpl = makeFetchSequence([]);
    await expect(
      hydrateCaseload("not-a-real-id", {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
      }),
    ).rejects.toThrow(/not a valid Salesforce Id/);
  });

  it("never embeds the bearer token in error messages", async () => {
    const fetchImpl = makeFetchSequence([
      new Response(JSON.stringify([{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }]), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ]);
    await expect(
      hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
      }),
    ).rejects.toThrowError(SalesforceError);
    // Sanity-check: SalesforceError code resolves to SF_AUTH_FAILED.
    try {
      await hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl: makeFetchSequence([
          new Response("[]", { status: 401 }),
        ]),
        now: () => FROZEN_NOW,
      });
    } catch (err) {
      expect((err as SalesforceError).code).toBe("SF_AUTH_FAILED");
      expect((err as Error).message.toLowerCase()).not.toContain("fake_token");
    }
  });

  it("maps 429 to SF_QUOTA_EXCEEDED", async () => {
    const fetchImpl = makeFetchSequence([
      new Response(
        JSON.stringify([{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "TotalRequests Limit exceeded." }]),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    ]);
    await expect(
      hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
      }),
    ).rejects.toMatchObject({ code: "SF_QUOTA_EXCEEDED" });
  });

  it("maps malformed query (400) to SF_QUERY_INVALID", async () => {
    const fetchImpl = makeFetchSequence([
      new Response(
        JSON.stringify([{ errorCode: "MALFORMED_QUERY", message: "syntax error" }]),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ]);
    await expect(
      hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
      }),
    ).rejects.toMatchObject({ code: "SF_QUERY_INVALID" });
  });

  it("maps a No-such-column (INVALID_FIELD) error to SF_QUERY_INVALID", async () => {
    // The class of failure P0-08d fixes: a SELECT naming a column the live
    // schema does not have. It is a schema error — not an FLS denial.
    const fetchImpl = makeFetchSequence([
      new Response(
        JSON.stringify([
          { errorCode: "INVALID_FIELD", message: "No such column 'Status__c' on entity 'IDW_Program_Enrollment__c'." },
        ]),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ]);
    await expect(
      hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
      }),
    ).rejects.toMatchObject({ code: "SF_QUERY_INVALID" });
  });

  it("maps INSUFFICIENT_FIELD_PERMISSIONS to SF_FIELD_FLS_DENIED on SOQL reads", async () => {
    const fetchImpl = makeFetchSequence([
      new Response(
        JSON.stringify([
          { errorCode: "INSUFFICIENT_FIELD_PERMISSIONS", message: "no read perm" },
        ]),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ]);
    await expect(
      hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
      }),
    ).rejects.toMatchObject({ code: "SF_FIELD_FLS_DENIED" });
  });

  it("surfaces a composite-batch sub-query error as SF_QUERY_INVALID", async () => {
    const fetchImpl = makeFetchSequence([
      jsonResponse(SYNTHETIC_ENROLLMENT_RESPONSE),
      jsonResponse({
        hasErrors: true,
        results: [
          { statusCode: 200, result: { totalSize: 0, done: true, records: [] } },
          {
            statusCode: 400,
            result: { errorCode: "INVALID_FIELD", message: "No such column on entity 'Incident_Participant__c'." },
          },
        ],
      }),
    ]);
    await expect(
      hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
      }),
    ).rejects.toMatchObject({ code: "SF_QUERY_INVALID" });
  });

  it("rejects non-positive-integer window-day options", async () => {
    const fetchImpl = makeFetchSequence([]);
    await expect(
      hydrateCaseload(SYNTHETIC_OWNER_ID, {
        auth: STATIC_AUTH,
        fetchImpl,
        now: () => FROZEN_NOW,
        incidentWindowDays: -7,
      }),
    ).rejects.toThrow(/incidentWindowDays must be a positive integer/);
  });
});

describe("hydrateCaseload — pagination", () => {
  it("follows nextRecordsUrl on the parent query", async () => {
    const page1 = {
      totalSize: 4,
      done: false,
      nextRecordsUrl: "/services/data/v67.0/query/abc-200",
      records: [SYNTHETIC_ENROLLMENT_RESPONSE.records[0], SYNTHETIC_ENROLLMENT_RESPONSE.records[1]],
    };
    const page2 = {
      totalSize: 4,
      done: true,
      records: [SYNTHETIC_ENROLLMENT_RESPONSE.records[2]],
    };
    const fetchImpl = makeFetchSequence([
      jsonResponse(page1),
      jsonResponse(page2),
      jsonResponse(SYNTHETIC_COMPOSITE_BATCH_RESPONSE),
    ]);
    const result = await hydrateCaseload(SYNTHETIC_OWNER_ID, {
      auth: STATIC_AUTH,
      fetchImpl,
      now: () => FROZEN_NOW,
    });
    expect(result.snapshots).toHaveLength(3);
    expect(result.roundTrips).toBe(3);
  });
});
