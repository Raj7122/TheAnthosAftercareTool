import type { TriggeredInvariantEntry } from "@anthos/api";

interface Props {
  readonly invariants: ReadonlyArray<TriggeredInvariantEntry>;
}

// EC-12 explicitly forbids hiding invariant triggers (FS v1.12 §F-03). When
// invariants fire on a row, surface them prominently above the breakdown
// table so the calibrating specialist can see why scoring is overridden.
export function TriggeredInvariantsBanner({ invariants }: Props) {
  if (invariants.length === 0) return null;
  return (
    <div className="rounded-md border border-tier1/30 bg-tier1/10 px-4 py-3 text-sm">
      <div className="font-semibold text-tier1">Triggered invariants</div>
      <ul className="mt-1 list-disc pl-5">
        {invariants.map((inv, idx) => (
          <li key={typeof inv === "string" ? inv : inv.invariant_id + idx}>
            {typeof inv === "string" ? (
              <code className="font-mono text-xs">{inv}</code>
            ) : (
              <>
                <span className="font-medium">{inv.display_label}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {inv.invariant_id}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
