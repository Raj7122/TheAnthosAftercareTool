// Synthetic Salesforce REST JSON shapes used by bulk-hydration unit tests.
// Shapes match the live `anthos-demo` schema verified by P0-08d; no real PII
// — Ids and
// values are made up but structurally identical to what
// `/services/data/v67.0/query` and `/composite/batch` return.
//
// Round-2 composite batch carries FOUR sub-results: index 0 = open Barriers
// (keyed by the PE Master-Detail FK `Program_Enrollment__c`), index 1 =
// `Incident_Participant__c` junction rows (keyed by `Contact__c`, Incident
// fields nested under `Incident__r`), index 2 = `Arrear__c` rows (keyed by the
// PE Lookup FK `Program_Enrollment__c`; P0-08b), index 3 = `Repair__c` rows
// (keyed two hops out via `Unit_Rental__r.Program_Enrollment__c`; P0-04e). The
// P0-08 case-note sub-query was dropped — `IDW_Case_Note__c` has no
// participant link.

// A User Id — the value the round-1 query filters `Aftercare_Owner__c` on.
export const SYNTHETIC_OWNER_ID = "005UO000002yzNdYAI";

// Distinct Contact Ids — A1/A2/A3 each map to one participant Contact; the
// incident junction rows below reference these so by-Contact grouping is
// exercised.
const CONTACT_A1 = "003U8000011zA001AA";
const CONTACT_A2 = "003U8000011zA002AA";
const CONTACT_A3 = "003U8000011zA003AA";

export const SYNTHETIC_ENROLLMENT_RESPONSE = {
  totalSize: 3,
  done: true,
  records: [
    {
      attributes: { type: "IDW_Program_Enrollment__c", url: "/x/A1" },
      Id: "a1kU800000pjmA1IAI",
      // P1H-01 display plumbing.
      Name: "John Stone - 05/2025",
      Client_Type__c: "ACS",
      Contact__r: { Name: "John Stone" },
      Aftercare_Owner__c: SYNTHETIC_OWNER_ID,
      Most_Recent_Successful_Contact__c: "2026-04-01",
      Aftercare_Start_Date__c: "2025-05-01",
      Aftercare_End_Date__c: "2026-05-01",
      Aftercare_Extension_End_Date__c: "2026-08-01",
      Aftercare_First_Due_Date__c: "2025-08-01",
      Aftercare_Second_Due_Date__c: "2025-11-01",
      Aftercare_Third_Due_Date__c: "2026-02-01",
      Aftercare_Fourth_Due_Date__c: "2026-05-01",
      Upcoming_Aftercare_Visit_Due_Date__c: "2026-05-15",
      Program_Enrollment_Outcome__c: null,
      Contact__c: CONTACT_A1,
      Account__c: null,
      Subsidy_Renewal_Re_Cert_Due_Date__c: "2026-09-01",
      Num_of_Aftercare_Check_Ins_Attempted__c: 3,
      Number_of_Aftercare_Check_Ins_Completed__c: 8,
      Number_of_Missed_Check_Ins__c: 1,
    },
    {
      attributes: { type: "IDW_Program_Enrollment__c", url: "/x/A2" },
      Id: "a1kU800000pjmA2IAI",
      // P1H-01 — multi-value picklist + null Contact__r relationship (exercise
      // the defensive `.?Name ?? null` projection).
      Name: "Bessie Alvarez - 9/2025",
      Client_Type__c: "ACS;HHN",
      Contact__r: null,
      Aftercare_Owner__c: SYNTHETIC_OWNER_ID,
      Most_Recent_Successful_Contact__c: null,
      Aftercare_Start_Date__c: "2025-09-15",
      Aftercare_End_Date__c: "2026-09-15",
      Aftercare_Extension_End_Date__c: null,
      Aftercare_First_Due_Date__c: "2025-12-15",
      Aftercare_Second_Due_Date__c: "2026-03-15",
      Aftercare_Third_Due_Date__c: "2026-06-15",
      Aftercare_Fourth_Due_Date__c: "2026-09-15",
      Upcoming_Aftercare_Visit_Due_Date__c: "2026-06-15",
      Program_Enrollment_Outcome__c: null,
      Contact__c: CONTACT_A2,
      Account__c: null,
      Subsidy_Renewal_Re_Cert_Due_Date__c: null,
      Num_of_Aftercare_Check_Ins_Attempted__c: 0,
      Number_of_Aftercare_Check_Ins_Completed__c: 12,
      Number_of_Missed_Check_Ins__c: 0,
    },
    {
      attributes: { type: "IDW_Program_Enrollment__c", url: "/x/A3" },
      Id: "a1kU800000pjmA3IAI",
      // P1H-01 — GRAD-prefixed Name (matches sandbox); null Client_Type__c
      // (exercise null pass-through).
      Name: "GRAD Edna Hunt - 07/2023",
      Client_Type__c: null,
      Contact__r: { Name: "Edna Hunt" },
      Aftercare_Owner__c: SYNTHETIC_OWNER_ID,
      Most_Recent_Successful_Contact__c: "2026-05-10",
      Aftercare_Start_Date__c: "2025-06-01",
      Aftercare_End_Date__c: "2026-06-01",
      Aftercare_Extension_End_Date__c: "2026-06-01",
      Aftercare_First_Due_Date__c: null,
      Aftercare_Second_Due_Date__c: null,
      Aftercare_Third_Due_Date__c: null,
      Aftercare_Fourth_Due_Date__c: "2026-06-01",
      Upcoming_Aftercare_Visit_Due_Date__c: null,
      Program_Enrollment_Outcome__c: "Graduated",
      Contact__c: CONTACT_A3,
      Account__c: "001U800000abcA3IAQ",
      // Null on purpose — exercises the "formula field present but
      // unpopulated" path. Salesforce always returns formula projections
      // in the query response (interface no longer optional).
      Subsidy_Renewal_Re_Cert_Due_Date__c: null,
      // Null check-in rollups — formula numbers can come back null.
      Num_of_Aftercare_Check_Ins_Attempted__c: null,
      Number_of_Aftercare_Check_Ins_Completed__c: null,
      Number_of_Missed_Check_Ins__c: null,
    },
  ],
};

export const SYNTHETIC_COMPOSITE_BATCH_RESPONSE = {
  hasErrors: false,
  results: [
    {
      // Index 0 — open Barriers, keyed by PE Master-Detail FK.
      statusCode: 200,
      result: {
        totalSize: 2,
        done: true,
        records: [
          {
            attributes: { type: "Barriers__c", url: "/x/b1" },
            Id: "a0bU8000000B1IAQ",
            Program_Enrollment__c: "a1kU800000pjmA1IAI",
            Type__c: "Cannot reach participant",
            Status__c: "Open",
            Stage__c: "Aftercare",
            Start_Date__c: "2026-03-01",
            End_Date__c: null,
          },
          {
            attributes: { type: "Barriers__c", url: "/x/b2" },
            Id: "a0bU8000000B2IAQ",
            Program_Enrollment__c: "a1kU800000pjmA3IAI",
            Type__c: "Medical/Mental Health Emergency",
            Status__c: "Open",
            Stage__c: "Aftercare",
            Start_Date__c: "2026-02-10",
            End_Date__c: null,
          },
        ],
      },
    },
    {
      // Index 1 — Incident_Participant__c junction rows, keyed by Contact__c,
      // Incident fields nested under `Incident__r`.
      statusCode: 200,
      result: {
        totalSize: 4,
        done: true,
        records: [
          {
            attributes: { type: "Incident_Participant__c", url: "/x/ip1" },
            Id: "a3xU8000000IP1IAQ",
            Contact__c: CONTACT_A1,
            Incident__c: "a0cU8000000I1IAQ",
            Role__c: "Participant",
            Incident__r: {
              attributes: { type: "Incident__c", url: "/x/i1" },
              Incident_Type__c: "Medical",
              Status__c: "Open",
              Critical_Incident__c: true,
              Incident_Start_Date_Time__c: "2026-04-25T14:30:00.000+0000",
            },
          },
          {
            attributes: { type: "Incident_Participant__c", url: "/x/ip2" },
            Id: "a3xU8000000IP2IAQ",
            Contact__c: CONTACT_A2,
            Incident__c: "a0cU8000000I2IAQ",
            Role__c: "Participant",
            Incident__r: {
              attributes: { type: "Incident__c", url: "/x/i2" },
              Incident_Type__c: "Property Damage",
              Status__c: "Closed",
              Critical_Incident__c: false,
              Incident_Start_Date_Time__c: "2026-04-10T09:00:00.000+0000",
            },
          },
          {
            // Orphan: no Contact link — must be dropped silently.
            attributes: { type: "Incident_Participant__c", url: "/x/ip3" },
            Id: "a3xU8000000IP3IAQ",
            Contact__c: null,
            Incident__c: "a0cU8000000I3IAQ",
            Role__c: "Witness",
            Incident__r: {
              attributes: { type: "Incident__c", url: "/x/i3" },
              Incident_Type__c: "Other",
              Status__c: "Open",
              Critical_Incident__c: false,
              Incident_Start_Date_Time__c: "2026-05-01T12:00:00.000+0000",
            },
          },
          {
            // Second incident for CONTACT_A1, with the Incident type and
            // critical flag unset — exercises per-field null coercion
            // (`?? null` and the `=== true` critical guard). The query's
            // `Incident__r.Incident_Start_Date_Time__c` filter means a row
            // with a wholly null `Incident__r` cannot come back, so the
            // realistic null case is individual unset Incident fields.
            attributes: { type: "Incident_Participant__c", url: "/x/ip4" },
            Id: "a3xU8000000IP4IAQ",
            Contact__c: CONTACT_A1,
            Incident__c: "a0cU8000000I4IAQ",
            Role__c: "Participant",
            Incident__r: {
              attributes: { type: "Incident__c", url: "/x/i4" },
              Incident_Type__c: null,
              Status__c: "Open",
              Critical_Incident__c: null,
              Incident_Start_Date_Time__c: "2026-05-05T08:15:00.000+0000",
            },
          },
        ],
      },
    },
    {
      // Index 2 — Arrear__c rows, keyed by the PE Lookup FK
      // `Program_Enrollment__c` (P0-08b). Synthetic: the `anthos-demo` sandbox
      // has 0 Arrear__c rows, so synthetic fixtures are the only path.
      // Status__c and Arrears_Purpose__c values are drawn ONLY from the live
      // restricted picklists (verified via SF MCP 2026-05-19):
      //   Status__c          : Identified | Under Review | Approved |
      //                        Resolved With Anthos Payment |
      //                        Resolved Without Anthos Payment
      //   Arrears_Purpose__c : Shelter Allowance | Subsidy | Tenant Share |
      //                        Utilities | Other | Subsidy & Shelter Allowance
      statusCode: 200,
      result: {
        totalSize: 4,
        done: true,
        records: [
          {
            // A1 arrear #1 — fully populated, unresolved.
            attributes: { type: "Arrear__c", url: "/x/ar1" },
            Id: "a45U8000000AR1IAQ",
            Program_Enrollment__c: "a1kU800000pjmA1IAI",
            Unit_Engagement__c: "a1MU8000000UR1IAQ",
            Status__c: "Under Review",
            Date_Identified__c: "2026-02-15",
            Date_Resolved__c: null,
            Arrears_Start_Date__c: "2025-11-01",
            Arrears_End_Date__c: "2026-02-01",
            Arrears_Purpose__c: "Tenant Share",
            Estimated_Amount__c: 2400.5,
            Amount_Paid__c: 0,
            Length_of_Time_Months_Formula__c: 3,
          },
          {
            // A1 arrear #2 — resolved-with-payment; exercises multi-arrears
            // per PE and the resolved-date path.
            attributes: { type: "Arrear__c", url: "/x/ar2" },
            Id: "a45U8000000AR2IAQ",
            Program_Enrollment__c: "a1kU800000pjmA1IAI",
            Unit_Engagement__c: null,
            Status__c: "Resolved With Anthos Payment",
            Date_Identified__c: "2025-09-01",
            Date_Resolved__c: "2025-12-20",
            Arrears_Start_Date__c: "2025-06-01",
            Arrears_End_Date__c: "2025-09-01",
            Arrears_Purpose__c: "Utilities",
            Estimated_Amount__c: 800,
            Amount_Paid__c: 800,
            Length_of_Time_Months_Formula__c: 3,
          },
          {
            // A3 arrear — exercises per-field null coercion: every nullable
            // field (lookup, dates, purpose, currency, formula-number) null.
            attributes: { type: "Arrear__c", url: "/x/ar3" },
            Id: "a45U8000000AR3IAQ",
            Program_Enrollment__c: "a1kU800000pjmA3IAI",
            Unit_Engagement__c: null,
            Status__c: "Identified",
            Date_Identified__c: null,
            Date_Resolved__c: null,
            Arrears_Start_Date__c: null,
            Arrears_End_Date__c: null,
            Arrears_Purpose__c: null,
            Estimated_Amount__c: null,
            Amount_Paid__c: null,
            Length_of_Time_Months_Formula__c: null,
          },
          {
            // Orphan: null Program_Enrollment__c — `groupBy` drops falsy keys,
            // so this row must not surface on any snapshot (mirrors the
            // incident orphan-row precedent above).
            attributes: { type: "Arrear__c", url: "/x/ar4" },
            Id: "a45U8000000AR4IAQ",
            Program_Enrollment__c: null,
            Unit_Engagement__c: null,
            Status__c: "Approved",
            Date_Identified__c: "2026-01-10",
            Date_Resolved__c: null,
            Arrears_Start_Date__c: "2025-10-01",
            Arrears_End_Date__c: "2026-01-01",
            Arrears_Purpose__c: "Subsidy & Shelter Allowance",
            Estimated_Amount__c: 1500,
            Amount_Paid__c: 250,
            Length_of_Time_Months_Formula__c: 3,
          },
        ],
      },
    },
    {
      // Index 3 — Repair__c rows, keyed two hops out via the
      // `Unit_Rental__r.Program_Enrollment__c` parent-relationship projection
      // (P0-04e). Synthetic: the `anthos-demo` sandbox has 0 Repair__c rows, so
      // synthetic fixtures are the only path. Status__c values are drawn ONLY
      // from the live picklist (verified via SF MCP 2026-05-20):
      //   open     : Need Identified | Collecting Bids | Open Repair Agreement |
      //              Repairing | Ready for Final Inspection
      //   terminal : Completed | Canceled
      // Pre_or_Post_Move_In__c is the SF formula — exact strings
      // "Pre Move-In" / "Post Move-In".
      statusCode: 200,
      result: {
        totalSize: 6,
        done: true,
        records: [
          {
            // A1 repair #1 — open + Post Move-In: the BR-25 trigger shape.
            attributes: { type: "Repair__c", url: "/x/rp1" },
            Id: "a5RU8000000RP1IAQ",
            Status__c: "Repairing",
            Pre_or_Post_Move_In__c: "Post Move-In",
            Completed_Date__c: null,
            Due_Date__c: "2026-05-30",
            Identification_Date__c: "2026-04-20",
            Urgency__c: "High",
            of_Days_Overdue__c: 12,
            Unit_Rental__r: {
              attributes: { type: "Unit_Rental__c", url: "/x/ur1" },
              Program_Enrollment__c: "a1kU800000pjmA1IAI",
            },
          },
          {
            // A1 repair #2 — terminal (Completed): does NOT trigger BR-25.
            // Exercises multi-repairs per PE and the completed-date path.
            attributes: { type: "Repair__c", url: "/x/rp2" },
            Id: "a5RU8000000RP2IAQ",
            Status__c: "Completed",
            Pre_or_Post_Move_In__c: "Post Move-In",
            Completed_Date__c: "2026-03-01",
            Due_Date__c: "2026-02-15",
            Identification_Date__c: "2026-01-10",
            Urgency__c: "Medium",
            of_Days_Overdue__c: 0,
            Unit_Rental__r: {
              attributes: { type: "Unit_Rental__c", url: "/x/ur1" },
              Program_Enrollment__c: "a1kU800000pjmA1IAI",
            },
          },
          {
            // A3 repair #1 — open status but Pre Move-In: does NOT trigger
            // BR-25 (Aftercare is post-move-in support). A2 is left with zero
            // Repair__c rows to exercise the empty-repairs[] path.
            attributes: { type: "Repair__c", url: "/x/rp3" },
            Id: "a5RU8000000RP3IAQ",
            Status__c: "Need Identified",
            Pre_or_Post_Move_In__c: "Pre Move-In",
            Completed_Date__c: null,
            Due_Date__c: "2026-06-01",
            Identification_Date__c: null,
            Urgency__c: "Low",
            of_Days_Overdue__c: 0,
            Unit_Rental__r: {
              attributes: { type: "Unit_Rental__c", url: "/x/ur3" },
              Program_Enrollment__c: "a1kU800000pjmA3IAI",
            },
          },
          {
            // A3 repair #2 — exercises per-field null coercion: status, phase,
            // every date, urgency, and the overdue formula-number all null.
            attributes: { type: "Repair__c", url: "/x/rp4" },
            Id: "a5RU8000000RP4IAQ",
            Status__c: null,
            Pre_or_Post_Move_In__c: null,
            Completed_Date__c: null,
            Due_Date__c: null,
            Identification_Date__c: null,
            Urgency__c: null,
            of_Days_Overdue__c: null,
            Unit_Rental__r: {
              attributes: { type: "Unit_Rental__c", url: "/x/ur3" },
              Program_Enrollment__c: "a1kU800000pjmA3IAI",
            },
          },
          {
            // Orphan A: null Unit_Rental__r (no Unit Engagement lookup) —
            // `groupBy`'s keyFn yields null, so this row is dropped.
            attributes: { type: "Repair__c", url: "/x/rp5" },
            Id: "a5RU8000000RP5IAQ",
            Status__c: "Collecting Bids",
            Pre_or_Post_Move_In__c: "Post Move-In",
            Completed_Date__c: null,
            Due_Date__c: null,
            Identification_Date__c: null,
            Urgency__c: "Medium",
            of_Days_Overdue__c: null,
            Unit_Rental__r: null,
          },
          {
            // Orphan B: Unit_Rental__r present but Program_Enrollment__c null
            // (Unit Engagement with no PE) — the `?? null` keyFn branch drops
            // it. Both orphan shapes must not surface on any snapshot.
            attributes: { type: "Repair__c", url: "/x/rp6" },
            Id: "a5RU8000000RP6IAQ",
            Status__c: "Open Repair Agreement",
            Pre_or_Post_Move_In__c: "Post Move-In",
            Completed_Date__c: null,
            Due_Date__c: null,
            Identification_Date__c: null,
            Urgency__c: "High",
            of_Days_Overdue__c: 3,
            Unit_Rental__r: {
              attributes: { type: "Unit_Rental__c", url: "/x/ur4" },
              Program_Enrollment__c: null,
            },
          },
        ],
      },
    },
  ],
};

export const EMPTY_ENROLLMENT_RESPONSE = {
  totalSize: 0,
  done: true,
  records: [],
};
