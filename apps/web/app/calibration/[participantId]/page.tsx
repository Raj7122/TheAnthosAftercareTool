import Link from "next/link";
import { notFound } from "next/navigation";

import { getCalibrationSet } from "@anthos/api";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { EmptyEngineBanner } from "../_components/EmptyEngineBanner";
import { FactorBreakdownTable } from "../_components/FactorBreakdownTable";
import { TriggeredInvariantsBanner } from "../_components/TriggeredInvariantsBanner";
import { isAllowed } from "../_lib/access";
import { primaryFactorLabel } from "../_lib/primary-factor";

// Per-participant detail view. AC-12: full factor breakdown surfaces here.
// Same gate as the list page.

export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ participantId: string }>;
  readonly searchParams: Promise<{ as?: string }>;
}

export default async function CalibrationParticipantPage({
  params,
  searchParams,
}: PageProps) {
  const [{ participantId }, { as }] = await Promise.all([params, searchParams]);
  const identity = as ?? null;
  if (!isAllowed(identity)) notFound();

  const participants = await getCalibrationSet();
  const dto = participants.find((p) => p.participantId === participantId);
  if (dto === undefined) notFound();

  const variant =
    dto.tier === 1
      ? "tier1"
      : dto.tier === 2
        ? "tier2"
        : dto.tier === 3
          ? "tier3"
          : "muted";

  return (
    <main className="container mx-auto max-w-4xl space-y-6 py-8">
      <div>
        <Button asChild variant="link" size="sm" className="px-0">
          <Link
            href={{ pathname: "/calibration", query: { as: identity } }}
          >
            ← Back to list
          </Link>
        </Button>
      </div>

      <header className="space-y-2">
        <h1 className="font-mono text-xl font-semibold">{dto.participantId}</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {dto.tierLabel !== null && (
            <Badge variant={variant}>{dto.tierLabel}</Badge>
          )}
          <span className="tabular-nums">
            Score:{" "}
            <strong>
              {dto.priorityScore === null
                ? "—"
                : dto.priorityScore.toFixed(2)}
            </strong>
          </span>
          <span>
            Primary Factor: <strong>{primaryFactorLabel(dto)}</strong>
          </span>
          {dto.configurationVersion !== null && (
            <span className="text-muted-foreground">
              config v{dto.configurationVersion}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Hydrated {dto.hydratedAt.toISOString()} · Owner{" "}
          <code className="font-mono">{dto.ownerId}</code>
        </p>
      </header>

      {!dto.scored && <EmptyEngineBanner />}

      <TriggeredInvariantsBanner invariants={dto.triggeredInvariants} />

      {dto.factors.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Factor breakdown
          </h2>
          <FactorBreakdownTable factors={dto.factors} />
        </section>
      ) : null}

      {dto.triggeredCaps.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Triggered overlap caps (BR-22)
          </h2>
          <ul className="space-y-2 text-sm">
            {dto.triggeredCaps.map((cap, idx) => (
              <li
                key={`${cap.winningFactor}-${idx}`}
                className="rounded-md border bg-muted/40 px-3 py-2"
              >
                <div>
                  Winning factor:{" "}
                  <code className="font-mono">{cap.winningFactor}</code> (
                  {cap.winningPoints.toFixed(2)} pts)
                </div>
                <div className="text-xs text-muted-foreground">
                  Absorbed: {cap.absorbedPoints.toFixed(2)} pts across{" "}
                  {cap.presentFactors.join(", ")}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
