import type {
  CaseloadFactor,
  CaseloadHighestImpactFactor,
  CaseloadTriggeredInvariant,
} from "@anthos/api";

// P1H-13b — value-bearing sentence for the F-02 row's WHY THIS PRIORITY cell.
//
// Replaces `primaryFactorLabel()`'s axis-only output ("Days since last
// successful contact") with the artifact's value-bearing copy ("Hasn't been
// reached in 12 days"). EC-12 still applies — a triggered invariant's
// `display_label` wins over the factor-derived sentence — so this function is
// a strict superset of `primaryFactorLabel()` for the row use case.
//
// Switches on the engine-stable `highestImpactFactor.key` (P1H-13b extended
// the wire DTO so SPA copy isn't coupled to display-label string equality).
// `factors[]` is consulted only for the empty-state check; the rendered string
// derives from the highest-impact factor alone, matching the BR-19 disclosure
// panel's primary row.
//
// Path C suppression is handled upstream in CaseloadRow (P1H-10); this
// formatter is never called for a suppressed row.

export interface FiringFactorInput {
  readonly highestImpactFactor: CaseloadHighestImpactFactor | null;
  readonly factors: ReadonlyArray<CaseloadFactor>;
  readonly triggeredInvariants: ReadonlyArray<CaseloadTriggeredInvariant>;
}

const ON_TRACK = "On track";

export function firingFactorMessage(input: FiringFactorInput): string {
  const invariant = input.triggeredInvariants[0];
  if (invariant !== undefined) {
    return invariant.display_label;
  }

  const top = input.highestImpactFactor;
  // No engine output (degraded row), or all factors quiet — both surface the
  // positive "engine looked and found nothing" copy per the artifact.
  if (top === null) return ON_TRACK;
  if (top.pointsContributed <= 0) return ON_TRACK;

  return renderFactorSentence(top, input.factors);
}

function renderFactorSentence(
  top: CaseloadHighestImpactFactor,
  factors: ReadonlyArray<CaseloadFactor>,
): string {
  switch (top.key) {
    case "days_since_last_contact": {
      const days = factorNumeric(factors, top.key);
      if (days === null) return top.valueLabel;
      return `Hasn't been reached in ${days} day${plural(days)}`;
    }
    case "failed_attempts": {
      const count = factorNumeric(factors, top.key);
      if (count === null) return top.valueLabel;
      return `${count} attempted contact${plural(count)}, 0 successful`;
    }
    case "stability_visit_state":
      // Engine valueLabel is one of "On track" | "Upcoming" | "Catch-up" |
      // "Missed". "On track" should not reach this branch (pointsContributed
      // would be 0 — handled above); the other three carry signal.
      return `Stability visit ${top.valueLabel.toLowerCase()}`;
    case "voucher_recert_deadline":
      // Engine valueLabel is "past due" | `recert in ${N} days` | "no recert
      // date". Wrap with capitalized voucher framing.
      if (top.valueLabel === "past due") return "Voucher recert past due";
      return `Voucher ${top.valueLabel}`;
    case "open_barriers": {
      // Engine valueLabel is `${count} open${summary}` (e.g., "3 open (2h/1m)").
      // Strip the summary so the headline reads cleanly.
      const match = /^(\d+)\s+open/.exec(top.valueLabel);
      if (match === null) return top.valueLabel;
      const count = Number(match[1]);
      return `${count} open barrier${plural(count)}`;
    }
    case "arrears": {
      // Engine valueLabel is `${count} open ${noun}` (e.g., "2 open arrears").
      const match = /^(\d+)\s+open\s+(\w+)/.exec(top.valueLabel);
      if (match === null) return top.valueLabel;
      const count = Number(match[1]);
      return `${count} open arrear${plural(count)}`;
    }
    case "aftercare_extended":
      return "Aftercare extended";
    case "recent_incident":
      return "Recent incident (30-day window)";
    case "sbop":
      // Unreachable in practice — Path C suppression owns the cell. Fall back
      // to the engine label so a config-flag flip doesn't render blank copy.
      return top.valueLabel;
    default:
      // Unknown key (a new factor lands before the formatter learns about it):
      // fall back to the engine valueLabel rather than crash.
      return top.valueLabel;
  }
}

function factorNumeric(
  factors: ReadonlyArray<CaseloadFactor>,
  key: string,
): number | null {
  const match = factors.find((f) => f.key === key);
  return match === undefined ? null : match.valueNumeric;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
