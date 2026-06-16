import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(i) — Voucher recertification deadline.
//
// GAP-17 closed 2026-05-19 by Julia (data-policy owner). Authoritative
// source on `IDW_Program_Enrollment__c` is the Salesforce-side formula
// `Subsidy_Renewal_Re_Cert_Due_Date__c` (Label: "Subsidy Renewal Due Date"):
//   IF(CONTAINS(Voucher__r.Name, 'HASA'),
//      Aftercare_End_Date__c,
//      Aftercare_End_Date__c - 60)
// HASA vouchers recert at the Aftercare end date; everything else recerts
// 60 days earlier. Cycle math stays Salesforce-side (Immutable #1) — the
// hydrator reads the resolved Date and the factor receives days-until as
// `voucher_recert_deadline: number | null`.
//
// Contribution shape:
//   - null / missing / non-finite input: 0 contribution, label "no recert
//     date". (Julia: 96.5% of sandbox rows are populated; absences are a
//     real signal, not a stub.)
//   - past-due (days <= 0): 0 contribution + `dataQualityWarning` per
//     Julia's B4-with-hedge ("almost always stale data, though we have no
//     way of truly knowing"). The "past due" valueLabel keeps the chip
//     visible to specialists; the warning lets calibration treat warned
//     rows distinctly. We do NOT max-blast the urgency contribution.
//   - in-window (1 <= days <= warningDays): linear scale, contribution =
//     warningDays - days. Boundary (days == warningDays) contributes 0.
//   - beyond-window (days > warningDays): 0 contribution.
//
// Default `voucherRecertWarningDays = 30` per FS v1.12; configurable via
// Configuration. Calibration sprint (P0-14) tunes the weight, not the
// shape.

export const voucherRecertDeadlineFactor: Factor = {
  key: "voucher_recert_deadline",
  displayName: "Voucher recertification deadline",
  type: "numeric",
  compute(
    participant: HydratedParticipant,
    configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["voucher_recert_deadline"];

    if (raw === undefined || raw === null) {
      return { valueLabel: "no recert date", valueNumeric: 0 };
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { valueLabel: "no recert date", valueNumeric: 0 };
    }

    const warningDays = configuration.voucherRecertWarningDays;

    if (raw <= 0) {
      return {
        valueLabel: "past due",
        valueNumeric: 0,
        dataQualityWarning: "voucher_recert_past_due_likely_stale",
      };
    }

    if (raw <= warningDays) {
      const contribution = warningDays - raw;
      return {
        valueLabel: `recert in ${raw} days`,
        valueNumeric: contribution,
      };
    }

    return { valueLabel: `recert in ${raw} days`, valueNumeric: 0 };
  },
};
