import { notFound } from "next/navigation";

import { getCalibrationSet } from "@anthos/api";

import { CalibrationTable } from "./_components/CalibrationTable";
import { EmptyEngineBanner } from "./_components/EmptyEngineBanner";
import { isAllowed } from "./_lib/access";

// P0-11 — calibration-only UI, gated to Marie + 1 specialist + Erik via the
// CALIBRATION_ALLOWLIST env var. Read-only Server Component; no mutating
// endpoints. SF reads happen server-side via the P0-08 hydration adapter
// (Immutable #3 preserved: token never reaches the browser).
//
// Identity is passed via `?as=<email>` in Phase 0; real per-user OAuth+PKCE
// lands in Phase 1.

export const dynamic = "force-dynamic";

interface PageProps {
  readonly searchParams: Promise<{ as?: string }>;
}

export default async function CalibrationPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const identity = params.as ?? null;
  if (!isAllowed(identity)) notFound();

  const participants = await getCalibrationSet();
  const anyScored = participants.some((p) => p.scored);

  return (
    <main className="container mx-auto max-w-6xl space-y-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Calibration view
        </h1>
        <p className="text-sm text-muted-foreground">
          Read-only engine output for the Phase-0 calibration cohort. Signed
          in as <code className="font-mono">{identity}</code>.{" "}
          {participants.length} participants.
        </p>
      </header>

      {!anyScored && <EmptyEngineBanner />}

      {participants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No participants returned. Check <code>CALIBRATION_OWNER_IDS</code>{" "}
          and the Salesforce credentials available to the BFF.
        </p>
      ) : (
        <CalibrationTable
          participants={participants}
          identity={identity as string}
        />
      )}
    </main>
  );
}
