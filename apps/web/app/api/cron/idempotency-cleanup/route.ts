// Daily TTL cleanup cron for the `idempotency_keys` table (P1A-03, TR-WRITE-2c).
// Registered in vercel.json `crons`. Vercel injects CRON_SECRET as a Bearer
// token on the scheduled request; any request without the matching token is
// rejected. This is a maintenance sweep, not a participant mutation, so it is
// not wrapped by the idempotency middleware.

import { runIdempotencyCleanup } from "@anthos/api";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

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
    const result = await runIdempotencyCleanup();
    return new Response(JSON.stringify(result), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    // Surface the failure to logs — a silently-failing cron lets the
    // idempotency_keys table grow unbounded.
    console.error(
      JSON.stringify({
        event: "idempotency_cleanup_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return new Response(
      JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "Idempotency cleanup failed.",
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
