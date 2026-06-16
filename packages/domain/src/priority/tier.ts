import type { TierThresholds } from "../config/index.js";

// Boundary convention: a score AT a cutoff lands in the HIGHER tier (lower
// tier number). Example with tier1_min=80, tier2_min=50:
//   score=80 → Tier 1
//   score=79.99 → Tier 2
//   score=49.99 → Tier 3 (implicit "below all declared minimums" bucket)
export function bucketTier(
  score: number,
  thresholds: TierThresholds,
): number {
  const sorted = parseTierEntries(thresholds);
  for (const entry of sorted) {
    if (score >= entry.min) return entry.tier;
  }
  // Score below every declared minimum → fall-through bucket
  // (max declared tier number + 1).
  const lastEntry = sorted[sorted.length - 1];
  const maxDeclared = lastEntry === undefined ? 0 : lastEntry.tier;
  return maxDeclared + 1;
}

// Spec-canonical tier labels per FS v1.12 §F-02 (line 400):
//   "Tier 1 / Tier 2 / Tier 3 ↔ Act today / Act this week / Routine".
// Confirmed in API v1.3 §7.3.1 example ("tierLabel": "Act today"). The tier
// itself is a computed engine output and is NOT stored in Salesforce (no
// `Priority_Tier__c` or equivalent picklist), so these labels are owned by
// the tool's spec, not by the SoR schema.
const DEFAULT_TIER_LABELS: Readonly<Record<number, string>> = Object.freeze({
  1: "Act today",
  2: "Act this week",
  3: "Routine",
});

export function tierLabelFor(tier: number): string {
  return DEFAULT_TIER_LABELS[tier] ?? `Tier ${tier}`;
}

interface ParsedTierEntry {
  readonly tier: number;
  readonly min: number;
}

// Exported so validate.ts can run VR-06 ordering checks against the same
// parsing logic the engine uses for bucketing.
export function parseTierEntries(
  thresholds: TierThresholds,
): ReadonlyArray<ParsedTierEntry> {
  const entries: ParsedTierEntry[] = [];
  for (const [key, value] of Object.entries(thresholds)) {
    const match = key.match(/^tier(\d+)_min$/);
    if (match === null || match[1] === undefined) continue;
    entries.push({ tier: Number.parseInt(match[1], 10), min: value });
  }
  // Ascending by tier number: tier 1 first (highest priority).
  entries.sort((a, b) => a.tier - b.tier);
  return entries;
}
