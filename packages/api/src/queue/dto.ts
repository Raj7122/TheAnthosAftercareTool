// Queue wire DTO assembly (P3C-05, E-17; F-14 Offline Tolerance).
//
// Builds the §7.5.1 `GET /api/v1/queue/pending` response body from the
// repository's `PendingQueueResult` (P3C-04 mirror of the client Outbox).
// Three pure helpers carry the substantive logic so the handler stays a thin
// orchestrator and the tricky bits (redaction, SF→resolution mapping) are
// independently unit-testable:
//
//   - `derivePayloadPreview` — minimal allow-list redactor on `payload` jsonb.
//      §7.5.1 notes: "payloadPreview is a redacted summary — does NOT echo
//      full PHI-suspect content; provides enough for specialist to identify
//      the queued action." See PR decision: allow-list shape across every
//      action_type for v1.
//
//   - `deriveSuggestedResolution` — maps `errorDetails.sfErrorCode` to one of
//      the three resolution actions per ERD §6.3. Defaults to `null` on
//      unknown codes (the SPA falls back to the full options list).
//
//   - `buildQueuePendingBody` — pure assembler that walks the rows + counts
//      and produces the wire envelope. No I/O; safe to call in any context.

import { z } from "zod";

import type {
  OfflineQueueRow,
  OfflineQueueStatus,
  PendingQueueResult,
  ResolutionAction,
  StatusCounts,
} from "@anthos/persistence";

// TR-OFFLINE-7 wire-spec constant: a specialist's queue is bounded at ≤100
// items. The repository (`QUEUE_PENDING_MAX_ITEMS` in
// `repositories/offline-queue.ts`) enforces the same number at the SQL LIMIT;
// duplicated here so this module stays pure (no value imports from
// `@anthos/persistence`, which would drag the DB-client side effect into the
// test runtime). The two constants MUST stay in lockstep.
const WIRE_MAX_QUEUE_DEPTH = 100;

// The three resolution actions exposed on every Review Required item. Spec
// §7.5.1 lists them as a constant — the SPA always offers all three; the
// `suggestedResolution` highlight is the server's recommendation.
export const RESOLUTION_OPTIONS: ReadonlyArray<ResolutionAction> = [
  "DISCARD",
  "REASSIGN_RETRY",
  "ESCALATE_TO_SUPERVISOR",
];

// Max length for the snippet field projected from `summary`/`note`/`body`.
// Short enough to fit on a single inspector row without wrapping; long enough
// to disambiguate two actions from the same actionType.
const PREVIEW_SNIPPET_MAX_LENGTH = 60;

// Max length for the wire-echoed `errorDetails.message`. The §7.5.1 example
// stores SF record IDs only (e.g., "Participant P was reassigned to specialist
// 0058K00000ABCDeQAO at 2026-05-09T11:00:00Z"), but Salesforce does not
// guarantee ID-only error text across every error code. The cap contains
// unexpected SF verbosity without changing the spec-shaped echo behavior.
const ERROR_MESSAGE_MAX_LENGTH = 200;

// Allow-listed scalar fields. Adding to this list widens the redaction
// envelope — review against Immutable #1 before changing.
const PREVIEW_SCALAR_KEYS = ["status", "outcome"] as const;

// Allow-listed snippet sources. First non-empty string wins; truncated +
// ellipsized to `PREVIEW_SNIPPET_MAX_LENGTH`. WIRE DIVERGENCE FROM §7.5.1:
// the spec example emits `summary` as a key; we emit a normalized `snippet`
// key sourced from whichever of `summary` / `note` / `body` is populated for
// the action_type. This collapses the per-action shape (calls have `summary`,
// case-notes have `note`, escalations have `body`) into one stable SPA key so
// P3C-12 / P3C-07 bind to `payloadPreview.snippet` regardless of action_type.
// User-approved during planning (minimal allow-list redaction). Worth a
// `[v1.4 note]` on §7.5.1 in the next spec amendment pass.
const PREVIEW_SNIPPET_KEYS = ["summary", "note", "body"] as const;

// One row of the wire response. Snake/camel mix follows the rest of the BFF:
// camelCase to match §7.5.1 example. `payloadPreview` is `Record<string, unknown>`
// because the allow-list emits an open record by design — the SPA only reads
// the keys it knows about.
export interface QueuePendingItem {
  readonly queueItemId: string;
  readonly participantId: string | null;
  readonly actionType: string;
  readonly status: OfflineQueueStatus;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
  readonly retryCount: number;
  readonly errorDetails: QueuePendingErrorDetails | null;
  readonly payloadPreview: Record<string, unknown>;
  readonly resolutionOptions: ReadonlyArray<ResolutionAction>;
  readonly suggestedResolution: ResolutionAction | null;
}

// Mirror of the §7.5.1 example: `{ sfErrorCode, message }`. The repository
// stores `error_details` as opaque jsonb (it accepts whatever the sync handler
// recorded); we project the two fields the SPA renders and drop the rest.
export interface QueuePendingErrorDetails {
  readonly sfErrorCode: string | null;
  readonly message: string | null;
}

export interface QueuePendingBody {
  readonly specialistId: string;
  readonly items: ReadonlyArray<QueuePendingItem>;
  readonly counts: StatusCounts;
  readonly queueDepth: number;
  readonly maxQueueDepth: number;
}

// §7.5.2 `POST /api/v1/queue/sync` wire body. The `itemsRouterToReview` key
// spelling is the published spec contract
// — preserved verbatim. Don't silently correct ("don't auto-correct
// vendor names or spec terms"); revisit on the next spec amendment pass.
//
// Scope note (P3C-06 endpoint shell): the per-item flush mechanics live in
// P3C-08 / P3C-09 / P3C-10. Until those land, `itemsCompleted` and
// `itemsRouterToReview` are both `0` and `itemsRemaining === itemsAttempted`
// — the response shape is stable across the shell→full-flush transition so
// the SPA bind point doesn't change.
export interface QueueSyncBody {
  readonly syncTriggeredAt: string;
  readonly itemsAttempted: number;
  readonly itemsCompleted: number;
  readonly itemsRouterToReview: number;
  readonly itemsRemaining: number;
}

// §7.5.3 `POST /api/v1/queue/:id/resolve` (E-19) wire shapes for P3C-07.
//
// NUMBERING NOTE — the impl-plan §3 row 463 + the ticket title both label
// this endpoint E-20, but API_v1_3.md §7.5 row 372 + §7.5.3 carry it as E-19
// (E-20 is `GET /supervisor/dashboard`). Per spec precedence the
// API doc wins; the impl-plan row + ticket need an amendment at archive time.
// This file uses E-19 throughout.
//
// Resolution action enum — three specialist-initiated dispositions per
// Pattern E line 36-50 + TR-OFFLINE-5a. No fourth path (Pattern E line 69:
// "Don't introduce a fourth resolution path"). EC-46's reverted-reassignment
// auto-resolution is explicitly deferred — every resolution here is
// specialist-initiated, `resolution_source='specialist'`.
const RESOLVE_ACTIONS = [
  "DISCARD",
  "REASSIGN_RETRY",
  "ESCALATE_TO_SUPERVISOR",
] as const satisfies ReadonlyArray<ResolutionAction>;

// `notes` cap per API §7.5.3: "max 1000 chars; appended to audit row." The
// PII firewall accepts this string into `payload_metadata.notes` because the
// field is specialist-authored rationale, not participant content. See
// `assertNoPii`'s contract — the writer rejects participant identifiers /
// PHI patterns regardless of key.
const NOTES_MAX_LENGTH = 1000;

// Strict schema — extra keys are rejected with 400 VALIDATION_FAILED. The
// `newOwnerId` conditional matches §7.5.3 row 1297 ("required when
// action='REASSIGN_RETRY'"). Zod here enforces only presence + non-empty;
// the handler then runs `assertSalesforceId` so the SF-id shape (15/18
// alphanumeric) rejects malformed ids before they reach `offline_queue.payload`.
export const queueResolveRequestSchema = z
  .object({
    action: z.enum(RESOLVE_ACTIONS, {
      required_error: "action is required",
      invalid_type_error: "action is required",
    }),
    newOwnerId: z.string().min(1).optional(),
    notes: z.string().max(NOTES_MAX_LENGTH).optional(),
  })
  .strict()
  .refine(
    (data) => data.action !== "REASSIGN_RETRY" || data.newOwnerId !== undefined,
    {
      path: ["newOwnerId"],
      message: "newOwnerId is required when action is REASSIGN_RETRY",
    },
  );

export type QueueResolveRequest = z.infer<typeof queueResolveRequestSchema>;

// §7.5.3 response bodies. Two shapes — DISCARD / REASSIGN_RETRY share the
// 200 shape; ESCALATE_TO_SUPERVISOR carries an additional `escalationId`
// and the `supervisorNotified` boolean on a 201.
export interface QueueResolveSuccessBody {
  readonly queueItemId: string;
  readonly status: OfflineQueueStatus;
  readonly resolvedAt: string;
  readonly resolvedBy: string;
  readonly resolutionSource: "specialist";
}

export interface QueueResolveEscalationBody {
  readonly queueItemId: string;
  readonly escalationId: string;
  readonly status: OfflineQueueStatus;
  readonly resolvedAt: string;
  readonly resolvedBy: string;
  readonly resolutionSource: "specialist";
  readonly supervisorNotified: boolean;
}

export type QueueResolveBody =
  | QueueResolveSuccessBody
  | QueueResolveEscalationBody;

// Pure body assembler. The caller (handler) supplies the resolved
// `specialistId` and the repository result; this function does the rest.
export function buildQueuePendingBody(input: {
  readonly specialistId: string;
  readonly result: PendingQueueResult;
}): QueuePendingBody {
  return {
    specialistId: input.specialistId,
    items: input.result.rows.map((row) => buildItem(row)),
    counts: input.result.counts,
    queueDepth: input.result.queueDepth,
    maxQueueDepth: WIRE_MAX_QUEUE_DEPTH,
  };
}

// Pure assembler for the §7.5.2 sync body. `now` is threaded so the handler
// and audit row stamp against an identical instant.
//
// `itemsAttempted` reads `counts.pending_sync` — the rows the future flush
// loop (P3C-08) will iterate. In-flight, review_required_*, and
// failed_max_retries rows are NOT replayed by /queue/sync (per ticket
// AC: "Flush replays only items NOT in `requires_review` state" and
// the state-machine semantics in TR-OFFLINE-5a). `itemsCompleted` and
// `itemsRouterToReview` are 0 in the shell — see the type doc above.
export function buildQueueSyncBody(input: {
  readonly result: PendingQueueResult;
  readonly now: Date;
}): QueueSyncBody {
  const itemsAttempted = input.result.counts.pending_sync;
  return {
    syncTriggeredAt: input.now.toISOString(),
    itemsAttempted,
    itemsCompleted: 0,
    itemsRouterToReview: 0,
    itemsRemaining: itemsAttempted,
  };
}

function buildItem(row: OfflineQueueRow): QueuePendingItem {
  const errorDetails = projectErrorDetails(row.errorDetails);
  // `resolutionOptions` is emitted on every item (not gated by status) so the
  // SPA binds to one uniform shape. Non-Review-Required items (status
  // `pending_sync`/`in_flight`) won't surface the resolve affordance — that's
  // a P3C-07 (resolve) UI gate, not a wire-shape gate.
  return {
    queueItemId: row.id,
    participantId: row.participantId,
    actionType: row.actionType,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    lastAttemptAt:
      row.lastAttemptAt === null ? null : row.lastAttemptAt.toISOString(),
    retryCount: row.retryCount,
    errorDetails,
    payloadPreview: derivePayloadPreview(row.payload),
    resolutionOptions: RESOLUTION_OPTIONS,
    suggestedResolution: deriveSuggestedResolution(errorDetails?.sfErrorCode ?? null),
  };
}

// Minimal allow-list redactor. Returns an object with at most three keys:
// `status` (string, from `payload.status`), `outcome` (string, from
// `payload.outcome`), and `snippet` (≤60-char ellipsized excerpt of the first
// non-empty string among `payload.summary` / `note` / `body`). Anything else
// in `payload` is dropped — never echoed.
//
// Pure: no I/O, deterministic, safe on `null`/non-object inputs.
export function derivePayloadPreview(payload: unknown): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  if (payload === null || typeof payload !== "object") {
    return preview;
  }
  const record = payload as Record<string, unknown>;
  for (const key of PREVIEW_SCALAR_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      preview[key] = value;
    }
  }
  for (const key of PREVIEW_SNIPPET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      preview.snippet = truncate(value, PREVIEW_SNIPPET_MAX_LENGTH);
      break;
    }
  }
  return preview;
}

// SF error code → resolution action per ERD §6.3. Returns `null` on unknown
// codes (the SPA still offers the full options list; this is a recommendation
// only, never a constraint).
export function deriveSuggestedResolution(
  sfErrorCode: string | null,
): ResolutionAction | null {
  if (sfErrorCode === null) return null;
  switch (sfErrorCode) {
    case "UNABLE_TO_LOCK_ROW":
      return "REASSIGN_RETRY";
    case "INVALID_CROSS_REFERENCE_KEY":
      return "ESCALATE_TO_SUPERVISOR";
    case "ENTITY_IS_DELETED":
      // OBQ-3 STUB: ERD §6.3 L651 leaves the default for ENTITY_IS_DELETED
      // open ("DISCARD or ESCALATE_TO_SUPERVISOR per OBQ-3"). Picking DISCARD
      // matches the most common SF posture (a hard-deleted participant cannot
      // be reassigned) and the SPA still surfaces all three `resolutionOptions`
      // so the specialist can override. Revisit when OBQ-3 closes.
      return "DISCARD";
    default:
      return null;
  }
}

function projectErrorDetails(raw: unknown): QueuePendingErrorDetails | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const sfErrorCode =
    typeof record.sfErrorCode === "string" ? record.sfErrorCode : null;
  // `message` is echoed from SF. The §7.5.1 example carries SF record IDs,
  // not participant names — but SF does not guarantee that across every
  // error code, so we cap the length defensively. The sync handler
  // (P3C-06) is the authoritative redactor at write time; this is belt-and-
  // suspenders against an SF format change.
  const rawMessage = typeof record.message === "string" ? record.message : null;
  const message =
    rawMessage === null ? null : truncate(rawMessage, ERROR_MESSAGE_MAX_LENGTH);
  if (sfErrorCode === null && message === null) return null;
  return { sfErrorCode, message };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  // Reserve one char for the ellipsis so the total is ≤ maxLength.
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
