// @anthos/logging — structured JSON logging + X-Trace-Id propagation (P1A-06;
// MON-LOG-2, MON-LOG-3, API §8.5, ERD §17.1). Feature code and middleware
// import only from this barrel.

export { createLogger } from "./logger.js";
export type {
  LogContext,
  LogLevel,
  PiiFirewallMode,
  StructuredLogger,
} from "./logger.js";

export {
  echoTraceId,
  forwardWithTraceId,
  generateTraceId,
  MAX_TRACE_ID_LENGTH,
  resolveTraceId,
} from "./trace.js";

export { assertLogSafe } from "./no-pii.js";

export { LogPiiError } from "./errors.js";
