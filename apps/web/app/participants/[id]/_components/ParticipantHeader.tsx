import type { ParticipantDetailBody } from "@anthos/api";

import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";

import { tierLabel } from "../_lib/tier-label";
import { FactorBreakdownDrawer } from "./FactorBreakdownDrawer";

type HeaderFields = Pick<
  ParticipantDetailBody,
  | "participantId"
  | "displayName"
  | "enrollmentCode"
  | "aftercareDay"
  | "programStatus"
  | "currentTier"
  | "recentContacts"
  | "cycleStatus"
  | "factors"
  | "triggered_invariants"
>;

interface Props {
  readonly identity: HeaderFields;
  // Public SF Lightning instance URL (e.g. https://anthoshome3--pursuit.sandbox.my.salesforce.com).
  // Wired from NEXT_PUBLIC_SF_INSTANCE_URL at the page level. `null` hides the link.
  readonly salesforceInstanceUrl: string | null;
}

// F-07 detail-view header. The single identity-and-priority surface: the name
// row carries the program badge + the F-02 tier pill ("Act today") as the
// primary at-a-glance signal, and a thin footer row carries the two scannable
// stats (days since contact, cycle posture) plus the BR-12 / AC-12 factor-
// breakdown drawer trigger. The raw engine score is intentionally not shown
// here — pre-calibration it's an internal number, not a specialist signal;
// the drawer remains the transparency surface. (Replaces the old full-width
// peach PriorityStrip band — same signals, far less real estate.)
//
// PII discipline (Immutable #1): the only routing-visible id is
// `participantId` (already in the URL path). `displayName` is rendered
// in-page only — never logged, never put in URLs or analytics.
export function ParticipantHeader({ identity, salesforceInstanceUrl }: Props) {
  const initials = computeInitials(identity.displayName);
  const dayLabel =
    identity.aftercareDay === null ? null : `Day ${identity.aftercareDay} of aftercare`;
  const subLineParts = [
    identity.enrollmentCode,
    identity.programStatus,
    dayLabel,
  ].filter((part): part is string => part !== null && part !== "");
  const sfHref =
    salesforceInstanceUrl === null
      ? null
      : `${salesforceInstanceUrl}/lightning/r/${encodeURIComponent(identity.participantId)}/view`;

  const tierText = tierLabel(identity.currentTier);
  const tierVariant = tierBadgeVariant(identity.currentTier);
  const daysSinceContact = computeDaysSinceContact(identity.recentContacts);
  const cyclePosture = computeCyclePosture(identity.cycleStatus);
  const hasFactors =
    identity.factors.length > 0 || identity.triggered_invariants.length > 0;

  return (
    <header
      aria-labelledby="participant-header-name"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
        >
          {initials}
        </span>
        <h1
          id="participant-header-name"
          className="text-xl font-semibold leading-tight"
        >
          {identity.displayName ?? "—"}
        </h1>
        <Tooltip content={tierTooltip(identity.currentTier)}>
          {tierText === null ? (
            <Badge variant="muted" className="rounded-full">
              No tier
            </Badge>
          ) : (
            <Badge variant={tierVariant} className="rounded-full">
              {tierText}
            </Badge>
          )}
        </Tooltip>
        <Badge variant="programModifier" className="rounded-full">
          {identity.programStatus}
        </Badge>
        {sfHref !== null && (
          <a
            href={sfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-sm text-primary underline-offset-4 hover:underline"
          >
            Open in Salesforce <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
      {subLineParts.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {subLineParts.join(" · ")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3">
        <Stat
          label="Since contact"
          value={daysSinceContact === null ? "—" : `${daysSinceContact}d`}
        />
        <Stat label="Cycle" value={cyclePosture} />
        {hasFactors && (
          <div className="ml-auto">
            <FactorBreakdownDrawer
              factors={identity.factors}
              triggeredInvariants={identity.triggered_invariants}
            />
          </div>
        )}
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <span className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  );
}

// Plain-language meaning of each priority tier, for the header pill tooltip.
function tierTooltip(tier: number | null): string {
  if (tier === 1) return "Highest priority — needs attention today.";
  if (tier === 2) return "Elevated priority — reach out this week.";
  if (tier === 3) return "Routine — no urgent action needed.";
  return "No priority tier assigned yet.";
}

function tierBadgeVariant(
  tier: number | null,
): "tier1" | "tier2" | "tier3" | "muted" {
  if (tier === 1) return "tier1";
  if (tier === 2) return "tier2";
  if (tier === 3) return "tier3";
  return "muted";
}

// "23d since contact" — derived from the most-recent timestamped row in
// `recentContacts[]`. The PE rollup yields at most one row today, so this is
// effectively "days since the last logged case note." Returns null when no
// timestamp is available (rollup empty or unparseable).
function computeDaysSinceContact(
  recentContacts: ReadonlyArray<{ readonly timestamp: string | null }>,
): number | null {
  const stamps = recentContacts
    .map((c) => (c.timestamp === null ? null : Date.parse(c.timestamp)))
    .filter((t): t is number => t !== null && !Number.isNaN(t));
  if (stamps.length === 0) return null;
  const mostRecent = Math.max(...stamps);
  return Math.max(0, Math.floor((Date.now() - mostRecent) / 86400000));
}

// Short cycle posture string for the header. Maps the F-05 BR-33 cycle state
// onto a one-word headline so the row stays scannable.
function computeCyclePosture(cycleStatus: {
  readonly state: string;
  readonly daysOverdue: number;
  readonly daysToNext: number | null;
}): string {
  if (cycleStatus.state === "overdue" && cycleStatus.daysOverdue > 0) {
    return `${cycleStatus.daysOverdue}d overdue`;
  }
  if (cycleStatus.state === "due" && cycleStatus.daysToNext !== null) {
    return `due in ${cycleStatus.daysToNext}d`;
  }
  if (cycleStatus.state === "catch_up") return "catch-up";
  if (cycleStatus.state === "complete" || cycleStatus.state === "cycle_complete") {
    return "complete";
  }
  if (cycleStatus.state === "not_in_cycle") return "not in cycle";
  if (cycleStatus.state === "pre_enrollment") return "pre-enrollment";
  if (cycleStatus.state === "between") return "between";
  return cycleStatus.state;
}

// "Michele Eiley" → "ME". Single-word names → first two letters. Returns
// "?" for null/empty so the avatar circle still renders with a glyph.
function computeInitials(displayName: string | null): string {
  if (displayName === null || displayName.trim() === "") return "?";
  const words = displayName.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  const first = words[0]![0] ?? "";
  const last = words[words.length - 1]![0] ?? "";
  return (first + last).toUpperCase();
}
