// DELETE /api/v1/participants/:id/suppression — clear an active Path C SBOP
// suppression (P1H-10 stub). Pattern F discipline: the route + handler are in
// place behind the existing `configuration.sbopEnabled` flag (still false,
// BR-21 / GAP-9 unratified). The data source for `pathCSuppression` does not
// exist yet (no SF field, no junction object, no tool-side stamp), so the
// handler returns a deterministic 404 (`RESOURCE_NOT_FOUND` with
// `details.resource: "suppression"`) on every call.
//
// When BR-21 ratifies and the upstream detection ticket lands, the only
// delta is the body of `runUnSuppress`:
//   - fetch the suppression record (data source TBD)
//   - apply the role gate (mirror close-barrier: SPECIALIST → own caseload,
//     VP → any, SUPERVISOR → 403 stub, SYSTEM_ADMIN → 403)
//   - clear it
//   - write the SUCCESS audit row BEFORE the response (Immutable #5)
// The middleware composition (`withSession(withIdempotency(handler))`),
// route shim, idempotency replay semantics, and validation all stay.
//
// Audit posture today: NO audit row is written. The 404 is a pre-mutation
// rejection (no data to clear), matching close-barrier's precedent that 4xx
// pre-mutation rejections (validation, 404, role-gate denial) are unaudited
// — VR-13 already-closed is the deliberate exception there per EC-20 and
// is not applicable here. When the handler grows the real clear path, the
// SUCCESS audit row gets added at the moment of clearing.
//
// PII firewall: the request takes no body. When P1H-10b adds suppression-
// record fields (provider, reason), they MUST NOT enter audit metadata or
// any persisted record outside Salesforce per ticket DoD + Immutable #1.

import { assertSalesforceId } from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { SessionConfig } from "@anthos/auth";

import { withIdempotency } from "../idempotency/middleware.js";
import type {
  IdempotentHandler,
  IdempotentRequestContext,
  WithIdempotencyOptions,
} from "../idempotency/middleware.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";

import {
  internalErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.participants.un-suppress" });

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// 404 — no active Path C suppression on this participant. Reuses the
// canonical `RESOURCE_NOT_FOUND` catalog code (API §9.4) with a `details.
// resource: "suppression"` discriminator so the SPA distinguishes this from
// a "participant not found" 404 without expanding the closed error catalog.
function suppressionNotFoundResponse(traceId: string): Response {
  return new Response(
    JSON.stringify({
      code: "RESOURCE_NOT_FOUND",
      message: "No active suppression to clear.",
      traceId,
      details: { resource: "suppression" },
    }),
    {
      status: 404,
      headers: {
        "Content-Type": JSON_CONTENT_TYPE,
        "Cache-Control": "no-store",
        "X-Trace-Id": traceId,
      },
    },
  );
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface UnSuppressHandlerOptions {
  // withSession seams.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // withIdempotency seam.
  readonly idempotencyStore?: IdempotencyStore;
}

export type UnSuppressRouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleUnSuppress(
  req: Request,
  routeCtx: UnSuppressRouteContext,
  options: UnSuppressHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("un-suppress route params resolution failed", {
      event: "un_suppress_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  // Compose withSession → withIdempotency → core. Same wrapping shape as
  // handleCloseBarrier so the post-ratification flip in P1H-10b inherits
  // the proven composition without rewiring.
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runUnSuppress(
        idemReq,
        { ...sessionCtx, ...idemCtx },
        participantId,
        log,
      );
    return withIdempotency(inner, idemOptions)(sessionReq, sessionCtx);
  };

  const sessionOptions: WithSessionOptions = {
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.sessionConfig !== undefined
      ? { config: options.sessionConfig }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  try {
    return await withSession(sessionCore, sessionOptions)(req);
  } catch (err) {
    log.error("un-suppress request failed unexpectedly", {
      event: "un_suppress_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// The middleware-resolved core. By this point: session is live, an
// `Idempotency-Key` UUIDv4 is held (the lock guards single execution per key).
async function runUnSuppress(
  _req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  log: StructuredLogger,
): Promise<Response> {
  try {
    assertSalesforceId(participantId, "participantId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "participantId",
      reason: "invalid_salesforce_id",
    });
  }

  // P1H-10 stub: no data source exists yet (BR-21 / GAP-9 unratified;
  // upstream detection ticket not yet built). Every call returns 404
  // deterministically. When P1H-10b ships, this body grows: data fetch,
  // role gate (mirror close-barrier: SPECIALIST own-caseload, VP any,
  // SUPERVISOR 403 stub, SYSTEM_ADMIN 403), clear the suppression, write a
  // SUCCESS Pattern B audit row BEFORE the response.
  log.info("un-suppress called against stub source — returning deterministic 404", {
    event: "un_suppress_stub_404",
  });
  return suppressionNotFoundResponse(ctx.traceId);
}
