import { afterEach, describe, expect, it, vi } from "vitest";

import { LogPiiError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function spies() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

// Parse the JSON line most recently handed to a console sink.
function parseLine(calls: readonly unknown[][]): Record<string, unknown> {
  const last = calls[calls.length - 1];
  return JSON.parse(String(last?.[0])) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger — record shape (MON-LOG-2)", () => {
  it("emits ISO-8601 timestamp, level, message, and module", () => {
    const s = spies();
    createLogger({ module: "api.test" }).info("hello");
    const rec = parseLine(s.log.mock.calls);
    expect(rec.timestamp).toMatch(ISO_8601);
    expect(rec.level).toBe("info");
    expect(rec.message).toBe("hello");
    expect(rec.module).toBe("api.test");
  });

  it("includes trace_id and specialist_id when bound in context", () => {
    const s = spies();
    createLogger({
      module: "api.test",
      traceId: "trace-1",
      specialistId: "0058K00000XYZ",
    }).warn("rejected");
    const rec = parseLine(s.warn.mock.calls);
    expect(rec.trace_id).toBe("trace-1");
    expect(rec.specialist_id).toBe("0058K00000XYZ");
  });

  it("omits specialist_id when no session is in scope", () => {
    const s = spies();
    createLogger({ module: "api.test", traceId: "trace-1" }).warn("x");
    const rec = parseLine(s.warn.mock.calls);
    expect(rec).not.toHaveProperty("specialist_id");
    expect(rec.trace_id).toBe("trace-1");
  });

  it("merges caller-supplied structured fields", () => {
    const s = spies();
    createLogger({ module: "api.test" }).error("boom", {
      event: "thing_failed",
      attempt: 3,
    });
    const rec = parseLine(s.error.mock.calls);
    expect(rec.event).toBe("thing_failed");
    expect(rec.attempt).toBe(3);
  });

  it("does not let a caller-supplied field shadow a canonical key", () => {
    const s = spies();
    createLogger({ module: "api.test", traceId: "real-trace" }).info("hi", {
      trace_id: "spoofed",
      module: "spoofed",
      event: "kept",
    });
    const rec = parseLine(s.log.mock.calls);
    expect(rec.trace_id).toBe("real-trace");
    expect(rec.module).toBe("api.test");
    expect(rec.event).toBe("kept");
  });
});

describe("createLogger — child context", () => {
  it("binds extra context without mutating the parent", () => {
    const s = spies();
    const parent = createLogger({ module: "api.test" });

    parent.child({ traceId: "child-trace" }).info("from child");
    expect(parseLine(s.log.mock.calls).trace_id).toBe("child-trace");

    parent.info("from parent");
    expect(parseLine(s.log.mock.calls)).not.toHaveProperty("trace_id");
  });
});

describe("createLogger — level routing + minLevel", () => {
  it("routes debug/info to console.log, warn to console.warn, error to console.error", () => {
    const s = spies();
    const log = createLogger({ module: "api.test", minLevel: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(s.log).toHaveBeenCalledTimes(2);
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.error).toHaveBeenCalledTimes(1);
  });

  it("drops records below minLevel (default `info` drops `debug`)", () => {
    const s = spies();
    createLogger({ module: "api.test" }).debug("nope");
    expect(s.log).not.toHaveBeenCalled();
  });
});

describe("createLogger — PII firewall (SEC-AUDIT-4 by extension)", () => {
  it("throws LogPiiError loudly in `throw` mode", () => {
    spies();
    const log = createLogger({ module: "api.test", piiMode: "throw" });
    expect(() => log.info("emailed jane@example.com")).toThrow(LogPiiError);
  });

  it("in `metric` mode drops the offending record and emits a safe meta-record", () => {
    const s = spies();
    const log = createLogger({ module: "api.test", piiMode: "metric" });

    expect(() => log.info("emailed jane@example.com")).not.toThrow();

    // The offending info() record is dropped — nothing reaches console.log.
    expect(s.log).not.toHaveBeenCalled();

    const meta = parseLine(s.error.mock.calls);
    expect(meta.event).toBe("logging.pii_firewall_blocked");
    expect(meta.rule).toBe("value:email-address");
    expect(meta.blocked_level).toBe("info");
    // The suspected value is never echoed back into the log stream.
    expect(JSON.stringify(meta)).not.toContain("jane@example.com");
  });
});
