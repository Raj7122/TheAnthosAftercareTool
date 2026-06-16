// GET /healthz (endpoint E-34 per API §6.8 / §7.9.1) — liveness probe. Always
// returns 200 {"status":"ok"} unless the process is dead. No auth, no DB,
// no Salesforce: a heavier readiness check belongs at /readyz (E-35, out of
// scope here). Consumed by the desktop iframe surface's connectivity heartbeat
// (TR-OFFLINE-2, P3C-03) on a 5-second poll, and by the ALB + MON-APM-5
// synthetic monitor in Production Mode.

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-cache",
    },
  });
}
