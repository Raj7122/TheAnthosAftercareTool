import type { CaseloadOpenBarrier } from "@anthos/api";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { BarrierBadge } from "../../../_components/participant/BarrierBadge";

interface Props {
  readonly barriers: ReadonlyArray<CaseloadOpenBarrier>;
  // When supplied, each row renders a Close affordance that calls back with
  // the row's Barrier. Omit to render the read-only list (the P1F-08
  // baseline behaviour). Per-row id appearing in `closingBarrierIds`
  // disables that row's button while the close round-trip is in flight.
  readonly onCloseBarrier?: (barrier: CaseloadOpenBarrier) => void;
  readonly closingBarrierIds?: ReadonlySet<string>;
  // Optional slot rendered in the section header alongside the title.
  // BarriersPanel injects the "Add Barrier" button through this slot when
  // the session role permits creates.
  readonly headerAction?: React.ReactNode;
}

// F-07 open-Barriers panel. 2026-05-25 wireframe restyle adds:
//   - severity-tinted left border on each row (red/amber/slate)
//   - "Stale Nd" indicator on rows whose age exceeds the staleness threshold
//   - "Opened <date>" sub-line for context
// Existing per-row close + header Add affordances unchanged (P1E-04b wiring).
export function OpenBarriersList({
  barriers,
  onCloseBarrier,
  closingBarrierIds,
  headerAction,
}: Props) {
  return (
    <section
      aria-labelledby="barriers-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="barriers-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Open Barriers
          {barriers.length > 0 && (
            <span className="ml-1 text-muted-foreground/70">
              ({barriers.length})
            </span>
          )}
        </h2>
        {headerAction}
      </div>
      {barriers.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No open Barriers.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {barriers.map((b) => {
            const isClosing = closingBarrierIds?.has(b.barrierId) ?? false;
            const stale = isStale(b.ageDays);
            const openedLabel = formatOpenedDate(b.openedAt);
            return (
              <li
                key={b.barrierId}
                className={`flex flex-col gap-1 rounded-md border-l-4 border border-l-current bg-background px-3 py-2 ${severityBorderClass(b.severity)}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <BarrierBadge barrier={b} />
                  <div className="flex items-center gap-2">
                    {stale && b.ageDays !== null && (
                      <Badge variant="muted">Stale {b.ageDays}d</Badge>
                    )}
                    {onCloseBarrier && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onCloseBarrier(b)}
                        disabled={isClosing}
                      >
                        {isClosing ? "Closing…" : "Close"}
                      </Button>
                    )}
                  </div>
                </div>
                {openedLabel !== null && (
                  <p className="text-xs text-muted-foreground">
                    Opened {openedLabel}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function severityBorderClass(
  severity: "high" | "medium" | "low" | null,
): string {
  if (severity === "high") return "text-barrierHigh";
  if (severity === "medium") return "text-barrierMedium";
  return "text-barrierLow";
}

// Stale threshold: 7 days. Matches BR-38's "stale barrier" rule of thumb
// without inventing a new config knob — surface the visual signal at the
// point of mutation friction.
function isStale(ageDays: number | null): boolean {
  return ageDays !== null && ageDays >= 7;
}

// ISO date / datetime → "Apr 22, 2026". Returns null when openedAt is
// missing or unparseable. UTC getters for substrate-stable rendering.
function formatOpenedDate(openedAt: string | null): string | null {
  if (openedAt === null) return null;
  const ms = Date.parse(openedAt);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
