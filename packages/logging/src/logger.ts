// Structured JSON logger (MON-LOG-2, MON-LOG-3). Emits one CloudWatch-shaped
// JSON record per line: ISO-8601 timestamp, level, message, plus correlation
// fields (trace_id, specialist_id, module) and arbitrary structured fields.
// Demo Mode writes to stdout/stderr, captured by Vercel's native log pipeline
// — the substitute for CloudWatch ingestion (Production infra; MON-LOG-6 is
// out of scope here).
//
// Every record passes the PII firewall (assertLogSafe) before emission — no
// message content, phone numbers, email addresses, or PII-keyed fields reach
// the log stream (SEC-AUDIT-4 by extension; no PII in logs).

import { LogPiiError } from "./errors.js";
import { assertLogSafe } from "./no-pii.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

// Severity order — a record below the logger's minLevel is dropped.
const LEVEL_RANK = new Map<LogLevel, number>([
  ["debug", 10],
  ["info", 20],
  ["warn", 30],
  ["error", 40],
]);

// Console sink per level. A Map (not a Record) keeps lookup off variable
// bracket-access (the repo convention for security/detect-object-injection).
const CONSOLE_SINK = new Map<LogLevel, (line: string) => void>([
  ["debug", (line) => console.log(line)],
  ["info", (line) => console.log(line)],
  ["warn", (line) => console.warn(line)],
  ["error", (line) => console.error(line)],
]);

// Canonical record keys a caller-supplied field may not shadow — keeps
// `timestamp` / `trace_id` / `module` etc. authoritative on every line.
const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  "timestamp",
  "level",
  "message",
  "module",
  "trace_id",
  "specialist_id",
]);

// How the firewall reacts to a PII violation:
//  - "throw"  — raise LogPiiError (dev/test; loud, fails the caller).
//  - "metric" — drop the offending record and emit a safe meta-record instead
//               (production; never crash a request over a log line).
export type PiiFirewallMode = "throw" | "metric";

export interface LogContext {
  // Originating module, e.g. "api.idempotency". Free-form; emitted verbatim.
  readonly module: string;
  // Correlation id (API §8.5). Bound per-request via `.child({ traceId })`.
  readonly traceId?: string;
  // Salesforce User Id of the acting specialist — emitted as `specialist_id`
  // when a session is in scope. An allowed identifier, never PII.
  readonly specialistId?: string;
  // Records below this level are dropped. Defaults to "info".
  readonly minLevel?: LogLevel;
  // PII-firewall reaction. Defaults to "metric" when NODE_ENV==="production",
  // else "throw".
  readonly piiMode?: PiiFirewallMode;
}

export interface StructuredLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  // Returns a logger with additional context bound (e.g. a per-request
  // traceId / specialistId). The parent is unchanged.
  child(extra: Partial<LogContext>): StructuredLogger;
}

function rank(level: LogLevel): number {
  return LEVEL_RANK.get(level) ?? 0;
}

function write(level: LogLevel, line: string): void {
  (CONSOLE_SINK.get(level) ?? CONSOLE_SINK.get("error"))?.(line);
}

function resolvePiiMode(ctx: LogContext): PiiFirewallMode {
  if (ctx.piiMode !== undefined) {
    return ctx.piiMode;
  }
  return process.env.NODE_ENV === "production" ? "metric" : "throw";
}

// Build the wire record. Key order is stable; snake_case matches the ERD
// column names and the CloudWatch field convention.
function buildRecord(
  level: LogLevel,
  ctx: LogContext,
  message: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    module: ctx.module,
  };
  if (ctx.traceId !== undefined) {
    record.trace_id = ctx.traceId;
  }
  if (ctx.specialistId !== undefined) {
    record.specialist_id = ctx.specialistId;
  }
  // Caller fields fill in around the canonical keys; a field keyed the same as
  // a canonical key is dropped rather than allowed to shadow it.
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !RESERVED_FIELD_KEYS.has(key)),
  );
  return { ...record, ...safeFields };
}

function emit(
  level: LogLevel,
  ctx: LogContext,
  message: string,
  fields: Record<string, unknown>,
): void {
  if (rank(level) < rank(ctx.minLevel ?? "info")) {
    return;
  }

  try {
    assertLogSafe(message, fields);
  } catch (err) {
    if (!(err instanceof LogPiiError)) {
      throw err;
    }
    if (resolvePiiMode(ctx) === "throw") {
      throw err;
    }
    // Production: drop the offending record, emit a safe meta-record. Only the
    // firewall rule + key path are recorded — never the suspected value.
    const meta = buildRecord("error", ctx, "log record blocked by PII firewall", {
      event: "logging.pii_firewall_blocked",
      blocked_level: level,
      rule: err.rule,
      key_path: err.keyPath,
    });
    write("error", JSON.stringify(meta));
    return;
  }

  write(level, JSON.stringify(buildRecord(level, ctx, message, fields)));
}

// Build a structured logger bound to `context`. Feature code and middleware
// import this from the @anthos/logging barrel.
export function createLogger(context: LogContext): StructuredLogger {
  return {
    debug: (message, fields = {}) => emit("debug", context, message, fields),
    info: (message, fields = {}) => emit("info", context, message, fields),
    warn: (message, fields = {}) => emit("warn", context, message, fields),
    error: (message, fields = {}) => emit("error", context, message, fields),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}
