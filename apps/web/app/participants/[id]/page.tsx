import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  handleGetParticipant,
  handleMe,
  type ParticipantDetailBody,
} from "@anthos/api";

import {
  NotInCaseloadState,
  ParticipantNotFoundState,
  ServiceUnavailableState,
  SomethingWentWrongState,
} from "./_components/error-states";
import {
  ParticipantDetailView,
  type SessionRole,
} from "./_components/ParticipantDetailView";
import type { CommsChannel } from "../../_lib/comms/types";

// P1H-11 (demo) — caseload quick-action icons deep-link here with `?compose=`
// to pre-open a compose sheet. Validate against the channel set so a junk
// param is simply ignored (no sheet opens).
function parseCompose(value: string | undefined): CommsChannel | null {
  if (value === "sms" || value === "email" || value === "schedule") {
    return value;
  }
  return null;
}

// F-07 participant detail page (P1F-08). Server-Component shell:
//   1. Fan out `handleMe` + `handleGetParticipant` in parallel against the
//      inbound session cookie. Same warm-cache discipline as `/caseload`.
//   2. 401 on either endpoint → redirect to login with `returnTo` set so the
//      specialist lands back on the same detail view after re-auth.
//   3. The E-08 endpoint surfaces user-facing outcomes (403 NOT_IN_OWN_CASELOAD,
//      404 RESOURCE_NOT_FOUND, 503 SF_UPSTREAM_UNAVAILABLE) — branded
//      error-state panels render those instead of throwing, so the user gets
//      a copy-controlled affordance with `Back to caseload` + trace id.
//   4. 200 → render `<ParticipantDetailView>` with the wire body + the role
//      from `/me` (needed for the AC-29 supervisor banner).
//
// PII firewall: the page never logs `displayName`, phone, email, or address.
// Only the SF record id (`participantId`) appears in routing, which already
// rides in the URL path. Error states quote `X-Trace-Id` for triage.

export const dynamic = "force-dynamic";

interface MeBody {
  readonly specialistId: string;
  readonly role: SessionRole;
  readonly barrierTypes: ReadonlyArray<string>;
}

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly compose?: string }>;
}

export default async function ParticipantDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const initialCompose = parseCompose((await searchParams).compose);
  const inboundHeaders = await headers();
  const cookie = inboundHeaders.get("cookie");
  const cookieHeader = cookie === null ? {} : { cookie };

  const meReq = new Request("http://internal/api/v1/me", {
    headers: cookieHeader,
  });
  const detailReq = new Request(
    `http://internal/api/v1/participants/${encodeURIComponent(id)}`,
    { headers: cookieHeader },
  );
  const detailCtx = { params: Promise.resolve({ id }) };

  const [meRes, detailRes] = await Promise.all([
    handleMe(meReq),
    handleGetParticipant(detailReq, detailCtx),
  ]);

  if (meRes.status === 401 || detailRes.status === 401) {
    redirect(
      `/api/v1/auth/login?returnTo=${encodeURIComponent(`/participants/${id}`)}`,
    );
  }

  const traceId = detailRes.headers.get("X-Trace-Id");

  if (!meRes.ok) {
    // `/me` is the role gate; if it failed for a non-auth reason, we can't
    // tell whether to render the supervisor banner. Fall back to the generic
    // error state rather than risk drawing a misleading affordance.
    return (
      <Frame>
        <SomethingWentWrongState traceId={traceId} />
      </Frame>
    );
  }

  if (detailRes.status === 200) {
    const body = (await detailRes.json()) as ParticipantDetailBody;
    const me = (await meRes.json()) as MeBody;
    // Public env var (URL is non-secret): the participant header renders the
    // "Open in Salesforce ↗" link only when this is set. Leaving it
    // unset (e.g. unconfigured local dev) gracefully hides the affordance.
    const salesforceInstanceUrl =
      process.env.NEXT_PUBLIC_SF_INSTANCE_URL ?? null;
    return (
      <Frame>
        <ParticipantDetailView
          body={body}
          role={me.role}
          barrierTypes={me.barrierTypes}
          salesforceInstanceUrl={salesforceInstanceUrl}
          specialistId={me.specialistId}
          initialCompose={initialCompose}
        />
      </Frame>
    );
  }

  if (detailRes.status === 403) {
    return (
      <Frame>
        <NotInCaseloadState traceId={traceId} />
      </Frame>
    );
  }
  if (detailRes.status === 404 || detailRes.status === 422) {
    // 404: spec-canonical "RESOURCE_NOT_FOUND" per API §7.4.1 / §9.4.
    // 422: spec-canonical "VALIDATION_FAILED" on `params.id` shape per
    // `responses.ts` `validationFailedResponse`. From the specialist's POV
    // both mean "this URL doesn't point to a participant," so they share
    // the same branded state — no back-channel data leak either way.
    return (
      <Frame>
        <ParticipantNotFoundState traceId={traceId} />
      </Frame>
    );
  }
  if (detailRes.status === 503) {
    return (
      <Frame>
        <ServiceUnavailableState traceId={traceId} />
      </Frame>
    );
  }
  return (
    <Frame>
      <SomethingWentWrongState traceId={traceId} />
    </Frame>
  );
}

function Frame({ children }: { readonly children: React.ReactNode }) {
  // 2026-05-25 redesign — bumped to max-w-7xl to give the 3-col detail layout
  // room to breathe on desktop. Mobile / tablet (< lg) collapses to a single
  // column regardless of frame width.
  return (
    <main className="container mx-auto max-w-7xl space-y-6 py-6">
      {children}
    </main>
  );
}
