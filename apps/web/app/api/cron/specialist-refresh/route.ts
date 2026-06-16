// P1G-04 / TR-SF-8: nightly self-heal hard-refresh per specialist at 02:00
// in each specialist's stored local timezone. The worker filters enumerated
// specialists to those whose local hour at this tick is 02 and refreshes
// them sequentially. Bearer `CRON_SECRET` auth mirrors
// `apps/web/app/api/cron/idempotency-cleanup/route.ts` — Vercel injects the
// secret on the scheduled invocation.
//
// NOT wired as a Vercel cron in `apps/web/vercel.json`: the Hobby plan
// caps cron schedules at daily cadence and limits the total cron count
// (https://vercel.com/docs/cron-jobs/usage-and-pricing), which rejects the
// hourly schedule (`0 * * * *`) this worker needs to fire at each
// specialist's local 02:00 across timezones. The route deploys and is
// hittable; the cadence is driven by an external scheduler (or by manual
// hits during the demo) until the project is on Pro or migrates to the
// Production substrate (Fargate scheduled task / EventBridge per SAD §12.2
// / ADR-06). Mirrors the posture of `apps/web/app/api/cron/sf-cdc-poll/route.ts`.
// When the schedule is wired (Pro / Production), use `0 * * * *` UTC — the
// per-specialist local-hour filter in the worker handles all timezones.
//
// One tick can fan out to ~12 specialists worst case (all in NYC TZ); each
// SF round-trip + cache write is small but sequential, so we raise the
// function timeout to give comfortable headroom inside Vercel Fluid Compute.

import { runNightlyCaseloadRefreshCron } from "@anthos/api";
import { createLogger } from "@anthos/logging";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
// ~12 specialists × ~5s each ≈ 60s worst case; raise headroom so a slow SF
// round-trip in one specialist's tick doesn't kill the others.
export const maxDuration = 120;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function isAuthorized(req: Request): boolean {
  const configured = process.env.CRON_SECRET;
  if (configured === undefined || configured.length === 0) {
    return false;
  }
  const header = req.headers.get("authorization");
  if (header === null) {
    return false;
  }
  const presented = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${configured}`);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return new Response(
      JSON.stringify({
        code: "UNAUTHORIZED",
        message: "Invalid or missing cron credentials.",
      }),
      { status: 401, headers: JSON_HEADERS },
    );
  }

  try {
    const result = await runNightlyCaseloadRefreshCron();
    return new Response(
      JSON.stringify({
        tick_started_at: result.tickStartedAt,
        target_local_hour: result.targetLocalHour,
        specialists_enumerated: result.specialistsEnumerated,
        specialists_considered: result.specialistsConsidered,
        specialists_refreshed: result.specialistsRefreshed,
        specialists_skipped_idempotent: result.specialistsSkippedIdempotent,
        specialists_failed: result.specialistsFailed,
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (err) {
    // Surface to the structured log stream — a silently-failing cron leaves
    // specialists with a stale morning cache (the failure mode TR-SF-8 is
    // designed to prevent). Never echo the raw message back to the caller —
    // could carry SF query text in theory; the audit log keeps the detail.
    const logger = createLogger({ module: "api.caseload.cron_refresh" });
    logger.error("nightly caseload refresh cron invocation failed", {
      event: "cron_refresh.invocation_failed",
      error_message: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "Nightly caseload refresh invocation failed.",
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
