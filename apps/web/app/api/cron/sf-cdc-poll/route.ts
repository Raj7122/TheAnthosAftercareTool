// P1C-03: HTTP entry point for the Salesforce CDC polling worker.
// The handler runs the worker's dual-pass (cycle → wait 30s → cycle) inside
// one invocation to land a 30s effective polling cadence per implementation
// plan §1.5 slaughter list item 17.
//
// NOT wired as a Vercel cron in `apps/web/vercel.json`: the Hobby plan caps
// cron schedules at daily cadence and limits the total cron count
// (https://vercel.com/docs/cron-jobs/usage-and-pricing), which would reject
// a 1-minute schedule at deploy time. The route deploys; the cadence is
// driven by an external scheduler (or by manual hits during the demo) until
// the project is on Pro or migrates to the Production substrate (Fargate
// singleton task per SAD §12.2 / ADR-06). See follow-up ticket noted in the
// P1C-03 PR description.
//
// Auth mirrors `apps/web/app/api/cron/idempotency-cleanup/route.ts` —
// `CRON_SECRET` as the Bearer token; any request without the matching token
// is rejected.

import { runPollInvocation } from "@anthos/api";
import { createLogger } from "@anthos/logging";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
// The dual-pass holds the function open for ~30s of sleep plus cycle time;
// raise the default 60s timeout headroom so an unlucky cycle does not abort
// mid-write. Within Vercel Fluid Compute pricing this is Active CPU only.
export const maxDuration = 60;

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
    const result = await runPollInvocation();
    return new Response(
      JSON.stringify({
        recovery_mode: result.recoveryMode,
        cycles: result.cycles.map((c) => ({
          trace_id: c.traceId,
          duration_ms: c.durationMs,
          events_total: c.eventsTotal,
          invalidations: c.invalidations,
          status: c.status,
          partial: c.partial,
        })),
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (err) {
    // Surface through the structured logger so the PII firewall applies even
    // when the failure short-circuits `runPollInvocation`'s own per-cycle
    // logging. `error_message` carries the framework-thrown text only —
    // never a SF query body or user-derived value.
    const logger = createLogger({ module: "api.workers.sf_cdc_poll" });
    logger.error("sf-cdc-poll invocation failed", {
      event: "sf_cdc_poll.invocation_failed",
      error_message: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "CDC poll invocation failed.",
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
