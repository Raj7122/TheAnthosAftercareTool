import Link from "next/link";

import type { CalibrationParticipantDTO } from "@anthos/api";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { primaryFactorLabel } from "../_lib/primary-factor";

interface Props {
  readonly participants: ReadonlyArray<CalibrationParticipantDTO>;
  readonly identity: string;
}

// Calibration list — one row per hydrated participant. AC-12 (FS v1.12 §F-03):
// "Tap on participant row reveals full factor breakdown." Each row links to
// /calibration/<participantId>?as=<identity> for the detail view.
export function CalibrationTable({ participants, identity }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Participant</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Tier</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead>Primary Factor</TableHead>
          <TableHead className="text-right">Invariants</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {participants.map((p) => (
          <TableRow key={p.participantId}>
            <TableCell>
              <Link
                href={{
                  pathname: `/calibration/${p.participantId}`,
                  query: { as: identity },
                }}
                className="font-mono text-xs underline-offset-4 hover:underline"
              >
                {p.participantId}
              </Link>
            </TableCell>
            <TableCell>
              <code className="font-mono text-xs text-muted-foreground">
                {p.ownerId}
              </code>
            </TableCell>
            <TableCell>
              <TierBadge tier={p.tier} tierLabel={p.tierLabel} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {p.priorityScore === null
                ? "—"
                : p.priorityScore.toFixed(2)}
            </TableCell>
            <TableCell>{primaryFactorLabel(p)}</TableCell>
            <TableCell className="text-right">
              {p.triggeredInvariants.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <Badge variant="tier1">{p.triggeredInvariants.length}</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TierBadge({
  tier,
  tierLabel,
}: {
  tier: number | null;
  tierLabel: string | null;
}) {
  if (tier === null || tierLabel === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const variant =
    tier === 1 ? "tier1" : tier === 2 ? "tier2" : tier === 3 ? "tier3" : "muted";
  return <Badge variant={variant}>{tierLabel}</Badge>;
}
