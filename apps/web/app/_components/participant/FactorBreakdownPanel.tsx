import type {
  CaseloadFactor,
  CaseloadTriggeredInvariant,
  RowTag,
} from "@anthos/api";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { TagChip } from "./TagChip";

// Inline-expanded factor breakdown beneath a caseload row. BR-12 (transparency)
// + AC-12 (tap reveals factors) + EC-12 (must surface triggered invariants
// when they fire).
//
// Mirrors `app/calibration/_components/FactorBreakdownTable.tsx` visually but
// is typed against `CaseloadFactor` (the wire DTO — no internal `key`).

interface Props {
  readonly factors: ReadonlyArray<CaseloadFactor>;
  readonly triggeredInvariants: ReadonlyArray<CaseloadTriggeredInvariant>;
  // The individual status chips the caseload row's severity summary rolls up.
  // Rendered here ("Contributing signals") so the detail stays available behind
  // the "Why this priority" expansion (severity-summary collapse). Optional +
  // empty-safe: the F-07 detail-page consumer (FactorBreakdownDrawer) passes
  // none and the section simply doesn't render.
  readonly tags?: ReadonlyArray<RowTag>;
}

export function FactorBreakdownPanel({
  factors,
  triggeredInvariants,
  tags,
}: Props) {
  return (
    <div className="space-y-3 border-t bg-muted/30 px-4 py-3">
      {triggeredInvariants.length > 0 && (
        <TriggeredInvariants invariants={triggeredInvariants} />
      )}
      {tags !== undefined && tags.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Contributing signals
          </h3>
          <div className="flex flex-wrap items-center gap-1">
            {tags.map((t) => (
              <TagChip key={t.key} tag={t} />
            ))}
          </div>
        </div>
      )}
      {factors.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Factor breakdown
          </h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Factor</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead className="text-right">Contribution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {factors.map((f) => (
                <TableRow key={f.name}>
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell>{f.valueLabel}</TableCell>
                  <TableCell className="text-right">{f.weight}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {f.pointsContributed.toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No factor contributions recorded for this participant.
        </p>
      )}
    </div>
  );
}

function TriggeredInvariants({
  invariants,
}: {
  readonly invariants: ReadonlyArray<CaseloadTriggeredInvariant>;
}) {
  return (
    <div className="rounded-md border border-tier1/30 bg-tier1/10 px-3 py-2 text-sm">
      <div className="font-semibold text-tier1">Triggered invariants</div>
      <ul className="mt-1 list-disc pl-5">
        {invariants.map((inv) => (
          <li key={inv.invariant_id}>
            <span className="font-medium">{inv.display_label}</span>
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {inv.invariant_id}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
