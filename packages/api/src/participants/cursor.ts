// Opaque, signed, per-caller pagination cursor for E-09 (`GET
// /participants/:id/case-notes`) and the future paginated reads (`/admin/audit`,
// `/supervisor/escalations`).
//
// Per API §10.1:
//   - structure is `{ t: ISO8601, id: <sf-id>, v: 1 }`, base64url-JSON,
//     SERVER-INTERNAL — not a documented client contract;
//   - cursors are valid for ≥7 days; older issuance → `CURSOR_EXPIRED`;
//   - cursors are NOT portable across users — embedded user scope; using
//     another caller's cursor → `CURSOR_INVALID`;
//   - format / signature failure → `CURSOR_INVALID`.
//
// Implementation: the canonical payload is signed with HMAC-SHA256, keyed by
// `ANTHOS_CURSOR_SIGNING_KEY` (32 raw bytes, base64-encoded in env). The
// caller's `specialistId` is mixed into the signed material so a cursor minted
// for one specialist cannot decode for another, even when the payload bytes
// match — this is the §10.1 "NOT portable across users" invariant.
//
// I/O-free, no DB / SF reads. `node:crypto` only.

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ENV_CURSOR_SIGNING_KEY = "ANTHOS_CURSOR_SIGNING_KEY";

// Raw key length: matches `ANTHOS_OAUTH_COOKIE_SECRET` (32 bytes, base64).
const KEY_BYTES = 32;

// SHA-256 = 32 bytes of MAC; keep the full digest as the signature.
const SIG_BYTES = 32;

// API §10.1: "Cursors are valid for ≥7 days after issuance."
const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Bump on any payload-shape change so old issued cursors fail closed.
const CURSOR_VERSION = 1 as const;

export interface CursorPayload {
  // Timestamp of the LAST item on the prior page — used by the SF query as
  // `WHERE occurredAt <= t AND id < lastId` so pagination is stable under
  // concurrent inserts (per ticket §Notes "Salesforce result sets shift").
  readonly t: string;
  // Salesforce record Id of the last item on the prior page — tiebreaker.
  readonly id: string;
}

interface SignedEnvelope {
  readonly t: string;
  readonly id: string;
  readonly v: typeof CURSOR_VERSION;
}

export class CursorInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorInvalidError";
  }
}

export class CursorExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorExpiredError";
  }
}

export interface EncodeCursorInput {
  readonly payload: CursorPayload;
  readonly specialistId: string;
  readonly signingKey: Buffer;
}

export interface DecodeCursorInput {
  readonly token: string;
  readonly specialistId: string;
  readonly signingKey: Buffer;
  readonly now?: () => Date;
}

// Mint a fresh cursor. The returned string is `base64url(payload).base64url(sig)`.
export function encodeCursor(input: EncodeCursorInput): string {
  assertKey(input.signingKey);
  const envelope: SignedEnvelope = {
    t: input.payload.t,
    id: input.payload.id,
    v: CURSOR_VERSION,
  };
  const payloadJson = JSON.stringify(envelope);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const sigB64 = signEnvelope(envelope, input.specialistId, input.signingKey);
  return `${payloadB64}.${sigB64}`;
}

// Decode + verify a cursor. Throws `CursorInvalidError` on any structural,
// version, signature, or user-mismatch failure; throws `CursorExpiredError`
// on an aged-out timestamp. Returns the typed payload on success.
export function decodeCursor(input: DecodeCursorInput): CursorPayload {
  assertKey(input.signingKey);

  const parts = input.token.split(".");
  if (parts.length !== 2) {
    throw new CursorInvalidError("cursor: malformed token (expected two segments)");
  }
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) {
    throw new CursorInvalidError("cursor: malformed token (empty segment)");
  }

  let envelope: SignedEnvelope;
  try {
    const decoded = Buffer.from(payloadB64, "base64url").toString("utf8");
    envelope = JSON.parse(decoded) as SignedEnvelope;
  } catch {
    throw new CursorInvalidError("cursor: malformed payload");
  }

  if (!isValidEnvelope(envelope)) {
    throw new CursorInvalidError("cursor: payload shape rejected");
  }

  const expectedSigB64 = signEnvelope(envelope, input.specialistId, input.signingKey);
  if (!safeEqualBase64Url(sigB64, expectedSigB64)) {
    throw new CursorInvalidError("cursor: signature mismatch");
  }

  const issuedAt = Date.parse(envelope.t);
  if (Number.isNaN(issuedAt)) {
    throw new CursorInvalidError("cursor: timestamp unparseable");
  }
  const now = (input.now ?? (() => new Date()))().getTime();
  if (now - issuedAt > CURSOR_TTL_MS) {
    throw new CursorExpiredError("cursor: TTL exceeded");
  }

  return { t: envelope.t, id: envelope.id };
}

// Decode an env-supplied base64 signing key into the raw 32-byte buffer used
// by HMAC-SHA256. Mirrors `decodeCookieKey` from `@anthos/auth` so operators
// have one mental model for "32-byte secret material in env."
export function decodeCursorSigningKey(base64Secret: string): Buffer {
  if (base64Secret.trim().length === 0) {
    throw new Error(
      `${ENV_CURSOR_SIGNING_KEY} is not set; cursor codec cannot sign or verify.`,
    );
  }
  const key = Buffer.from(base64Secret, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${ENV_CURSOR_SIGNING_KEY} must decode to exactly ${KEY_BYTES} bytes (base64); ` +
        `got ${key.length}. Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

// Loads the signing key from `process.env` once per call. Tests pass a key
// buffer directly via the handler `options` seam and never invoke this path.
export function loadCursorSigningKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env[ENV_CURSOR_SIGNING_KEY] ?? "";
  return decodeCursorSigningKey(value);
}

// Convenience for tests: a fresh, in-memory key. Never used in production.
export function generateCursorSigningKeyForTests(): Buffer {
  return randomBytes(KEY_BYTES);
}

function signEnvelope(
  envelope: SignedEnvelope,
  specialistId: string,
  key: Buffer,
): string {
  const mac = createHmac("sha256", key);
  // Field separator chosen so no field's content can collide with another's
  // boundary (`|` does not appear in ISO timestamps, Salesforce Ids, or the
  // version integer; `specialistId` is a Salesforce User Id, also `|`-free).
  mac.update(`${envelope.t}|${envelope.id}|${envelope.v}|${specialistId}`, "utf8");
  return mac.digest("base64url");
}

function isValidEnvelope(value: unknown): value is SignedEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.t === "string" &&
    typeof candidate.id === "string" &&
    candidate.v === CURSOR_VERSION
  );
}

function safeEqualBase64Url(a: string, b: string): boolean {
  const ba = Buffer.from(a, "base64url");
  const bb = Buffer.from(b, "base64url");
  if (ba.length !== SIG_BYTES || bb.length !== SIG_BYTES) return false;
  return timingSafeEqual(ba, bb);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `cursor signing key must be ${KEY_BYTES} bytes; got ${key.length}.`,
    );
  }
}
