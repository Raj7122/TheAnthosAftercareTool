import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";

// Optional data envelope. When SF Contact-side demographic fields are
// hydrated through the detail endpoint, the page passes a populated
// `demographics` prop and the card flips from stub to live.
export interface DemographicsContext {
  readonly age: number | null;
  readonly languagePreference: string | null;
  readonly householdSummary: string | null;
  readonly disabilityAccommodations: string | null;
}

interface Props {
  readonly demographics?: DemographicsContext | undefined;
}

// F-07 wireframe demographics card. These details are NOT in the priority
// score (BR-19 enumerates the seven scored factors plus invariants — none
// of these qualify). The "Not in priority score" tag is load-bearing for
// BR-12 transparency: specialists need the context for judgment, but the
// engine treats them as non-signal. Stub renders the labeled shell with
// `—` placeholders until the SF Contact read scope + demographic field
// hydration land.
export function DemographicsContextCard({ demographics }: Props) {
  const isStub = demographics === undefined;
  return (
    <section
      aria-labelledby="demographics-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2
          id="demographics-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Demographics — context
        </h2>
        <Tooltip content="Shown for your judgment only — never factored into the priority score." side="bottom">
          <Badge variant="muted">Not in priority score</Badge>
        </Tooltip>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        These details are visible for your judgment but are NOT factored into
        the priority score.
      </p>
      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Age" value={ageLabel(demographics?.age)} />
        <Row
          label="Language preference"
          value={demographics?.languagePreference ?? "—"}
        />
        <Row
          label="Household"
          value={demographics?.householdSummary ?? "—"}
        />
        <Row
          label="Disability accommodations"
          value={demographics?.disabilityAccommodations ?? "None recorded"}
        />
      </dl>
      {isStub && (
        <p role="note" className="mt-3 text-xs text-muted-foreground">
          Additional details aren&rsquo;t available yet.
        </p>
      )}
    </section>
  );
}

function ageLabel(age: number | null | undefined): string {
  if (age === null || age === undefined) return "—";
  return String(age);
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
