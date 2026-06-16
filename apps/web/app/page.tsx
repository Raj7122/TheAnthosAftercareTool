import { headers } from "next/headers";

import { handleCaseload, handleMe, type CaseloadBody } from "@anthos/api";

import { LandingSwitch } from "./_components/tablet/LandingSwitch";
import { DEFAULT_LANDING_QUEUE_ID } from "./caseload/_lib/queue-labels";

// `/` — variant-routed landing. The laptop branch is still a placeholder; the
// tablet branch renders the F-13 field-card surface and hydrates its
// truncated "Today's caseload" mini-list from real F-02 data when a live
// session is present.
//
// Auth posture: `/` MUST stay 200 OK on every request (no redirect chain).
// Playwright's E2E webServer URL probe polls this exact origin; a 307 →
// /api/v1/auth/login → mock SF chain never converges in the test env and
// the whole CI run times out at the 240s webServer mark. So the page
// soft-handles 401 by rendering with empty caseload data — the tablet
// variant falls back to its demo fixtures and the laptop branch is itself
// a placeholder. The downstream routes (`/caseload`, `/participants/[id]`)
// still gate on auth; only `/` is intentionally tolerant.

export const dynamic = "force-dynamic";

export default async function Page() {
  const inboundHeaders = await headers();
  const cookie = inboundHeaders.get("cookie");

  const meReq = new Request("http://internal/api/v1/me", {
    headers: cookie === null ? {} : { cookie },
  });
  const caseloadUrl = new URL(
    `/api/v1/caseload?queue=${encodeURIComponent(DEFAULT_LANDING_QUEUE_ID)}`,
    "http://internal",
  );
  const caseloadReq = new Request(caseloadUrl, {
    headers: cookie === null ? {} : { cookie },
  });

  const [meRes, caseloadRes] = await Promise.all([
    handleMe(meReq),
    handleCaseload(caseloadReq),
  ]);

  // Surface unexpected /me failures (5xx, etc.); 401 is the "no live session"
  // branch and is acceptable — render the tablet view with empty data.
  if (!meRes.ok && meRes.status !== 401) {
    throw new Error(`/me bootstrap failed: ${meRes.status} ${meRes.statusText}`);
  }

  let specialistName: string | null = null;
  let specialistId: string | null = null;
  // P3C-14 — the 📝 Log Case Note quick action is a write affordance; system
  // admins are read-only (mirrors `CaseloadView`'s `role !== "system_admin"`).
  // Defaults off so the unauthenticated landing never offers it.
  let canLogCaseNotes = false;
  if (meRes.ok) {
    const meBody = (await meRes.json()) as {
      displayName: string | null;
      specialistId: string;
      role: string;
    };
    specialistName = meBody.displayName;
    specialistId = meBody.specialistId;
    canLogCaseNotes = meBody.role !== "system_admin";
  }

  let initialItems: CaseloadBody["items"] = [];
  let totalCount = 0;
  if (caseloadRes.ok) {
    const body = (await caseloadRes.json()) as CaseloadBody;
    initialItems = body.items;
    totalCount = body.queueCounts["caseload_overview"] ?? body.items.length;
  }

  return (
    <LandingSwitch
      initialCaseloadItems={initialItems.slice(0, 3)}
      caseloadCount={totalCount}
      specialistName={specialistName}
      specialistId={specialistId}
      canLogCaseNotes={canLogCaseNotes}
      // `meRes.ok` is the clean "live session" signal: a 5xx already threw
      // above, so the only non-ok branch here is the 401 (no session). Don't
      // reuse `specialistName !== null` — displayName can be null when authed.
      isAuthenticated={meRes.ok}
    />
  );
}
