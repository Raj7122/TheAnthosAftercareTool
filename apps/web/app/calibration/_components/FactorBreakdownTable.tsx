import type { FactorContribution } from "@anthos/domain";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Props {
  readonly factors: ReadonlyArray<FactorContribution>;
}

// Per-row breakdown table (BR-19 a–i). One row per FactorContribution. P0-04
// will populate the list; until then the upstream caller renders an empty
// state so this component never receives []. Internal `key` is shown
// alongside `name` because this surface is gated to 3 calibrators who need
// to cross-reference against spec citations.
export function FactorBreakdownTable({ factors }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Factor</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="text-right">Weight</TableHead>
          <TableHead className="text-right">Contribution</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {factors.map((f) => (
          <TableRow key={f.key}>
            <TableCell className="font-medium">{f.name}</TableCell>
            <TableCell>
              <code className="font-mono text-xs text-muted-foreground">
                {f.key}
              </code>
            </TableCell>
            <TableCell>{f.valueLabel}</TableCell>
            <TableCell className="text-right">{f.weight}</TableCell>
            <TableCell className="text-right tabular-nums">
              {f.pointsContributed.toFixed(2)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
