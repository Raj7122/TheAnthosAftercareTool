import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { handleCaseload, handleMe, type CaseloadBody } from "@anthos/api";

import { CaseloadView, type SessionRole } from "./_components/CaseloadView";
import { DEFAULT_LANDING_QUEUE_ID } from "./_lib/queue-labels";

// /caseload — F-02 + F-04 SPA. Server-Component shell:
//   1. Builds a `Request` from the inbound cookies + headers.
//   2. Calls `handleMe(req)` to bootstrap the SPA — role gate (F-01) +
//      session-start config (FS v1.12 §F-06 EC-22 barrierTypes picklist).
//   3. Calls `handleCaseload(req)` directly (no HTTP loopback) so AC-05 is
//      hit on a warm cache.
//   4. Hands the initial body off to the client `CaseloadView`, which owns
//      queue switching, the breakdown expand/collapse state, the stale
//      clock, and the Pattern A create/close-Barrier flows from there on.
//
// Default landing queue: `due_soon` per Q-DEMO-1 (overrides BR-20's spec
// default `caseload_overview` as a demo presentation choice — the "today's
// action queue" framing).

export const dynamic = "force-dynamic";

interface MeBody {
  readonly specialistId: string;
  readonly role: SessionRole;
  readonly barrierTypes: ReadonlyArray<string>;
  readonly displayName: string | null;
}

export default async function CaseloadPage() {
  const inboundHeaders = await headers();
  const cookie = inboundHeaders.get("cookie");

  // Bootstrap: /me + /caseload in parallel. Both gate on `withSession`, so a
  // 401 on either is the canonical "no live session" signal — checking each
  // independently and redirecting on the first 401 we see is observably
  // equivalent to a serial fetch with sub-millisecond cost. The parallel
  // fan-out halves the cold-start SSR latency.
  const initialQueueId = DEFAULT_LANDING_QUEUE_ID;
  const meReq = new Request("http://internal/api/v1/me", {
    headers: cookie === null ? {} : { cookie },
  });
  const caseloadUrl = new URL(
    `/api/v1/caseload?queue=${encodeURIComponent(initialQueueId)}`,
    "http://internal",
  );
  const caseloadReq = new Request(caseloadUrl, {
    headers: cookie === null ? {} : { cookie },
  });
  const [meRes, res] = await Promise.all([
    handleMe(meReq),
    handleCaseload(caseloadReq),
  ]);

  if (meRes.status === 401 || res.status === 401) {
    redirect("/api/v1/auth/login?returnTo=/caseload");
  }
  if (!meRes.ok) {
    throw new Error(`/me bootstrap failed: ${meRes.status} ${meRes.statusText}`);
  }
  if (!res.ok) {
    throw new Error(
      `caseload initial fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  const meBody = (await meRes.json()) as MeBody;
  const body = (await res.json()) as CaseloadBody;
  const fetchedAt = new Date().toISOString();

  return (
    <main className="container mx-auto max-w-6xl space-y-6 py-6">
      <CaseloadView
        initialBody={body}
        initialFetchedAt={fetchedAt}
        role={meBody.role}
        barrierTypes={meBody.barrierTypes}
        specialistId={meBody.specialistId}
        displayName={meBody.displayName}
      />
    </main>
  );
}
