import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  OfflineQueueStatus,
  ResolutionAction,
  ResolutionSource,
} from "../../src/offline-queue/index.js";

// TR-OFFLINE-5a parity gate.
//
// The state-machine module mirrors the persistence-layer vocabulary locally so
// `packages/domain/` stays I/O-free at runtime (no `@anthos/persistence` dep).
// This test reads the persistence schema file directly via fs at test time and
// asserts set-equality between the on-disk source-of-truth and the local
// mirror — so any drift (renamed status, added resolution source) fails CI
// loudly without coupling the dep graph.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../../packages/persistence/src/schema/offline_queue.ts",
);

const LOCAL_STATUSES = [
  "pending_sync",
  "in_flight",
  "completed",
  "review_required_reassigned",
  "review_required_terminated",
  "failed_max_retries",
  "discarded",
] as const satisfies ReadonlyArray<OfflineQueueStatus>;

const LOCAL_RESOLUTION_ACTIONS = [
  "DISCARD",
  "REASSIGN_RETRY",
  "ESCALATE_TO_SUPERVISOR",
] as const satisfies ReadonlyArray<ResolutionAction>;

const LOCAL_RESOLUTION_SOURCES = [
  "auto_retry",
  "auto_max_retries",
  "auto_lock_retry",
  "specialist",
  "supervisor",
  "system",
] as const satisfies ReadonlyArray<ResolutionSource>;

describe("offline-queue parity — local mirror ⇄ persistence schema", () => {
  const schemaSource = readFileSync(SCHEMA_PATH, "utf8");

  it("OfflineQueueStatus union matches persistence CHECK constraint", () => {
    const checkConstraint = extractCheckListedValues(
      schemaSource,
      "offline_queue_status_check",
    );
    expect(new Set(checkConstraint)).toEqual(new Set(LOCAL_STATUSES));
  });

  it("ResolutionAction union matches persistence CHECK constraint", () => {
    const checkConstraint = extractCheckListedValues(
      schemaSource,
      "offline_queue_resolution_action_check",
    );
    expect(new Set(checkConstraint)).toEqual(new Set(LOCAL_RESOLUTION_ACTIONS));
  });

  it("ResolutionSource union matches persistence CHECK constraint", () => {
    const checkConstraint = extractCheckListedValues(
      schemaSource,
      "offline_queue_resolution_source_check",
    );
    expect(new Set(checkConstraint)).toEqual(new Set(LOCAL_RESOLUTION_SOURCES));
  });
});

// Pulls the quoted values out of a `check("<name>", sql`<col> [IS NULL OR] IN
// ('a', 'b', …)`)` block. The schema file uses single-quoted SQL string
// literals (offline_queue.ts:95/99/103), so a flat single-quote regex
// suffices.
function extractCheckListedValues(
  source: string,
  constraintName: string,
): string[] {
  // `constraintName` is a test-file literal in every call site (never user
  // input); the dynamic RegExp here is safe and the rule's warning would
  // otherwise need to suppress everywhere we extract a named SQL block.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const blockRegex = new RegExp(
    `check\\(\\s*"${constraintName}"[\\s\\S]*?\\),`,
    "m",
  );
  const block = source.match(blockRegex);
  if (block === null) {
    throw new Error(
      `parity test: could not find CHECK constraint '${constraintName}' in ${SCHEMA_PATH}`,
    );
  }
  const valueRegex = /'([^']+)'/g;
  const values = [...block[0].matchAll(valueRegex)].map((match) => match[1]);
  if (values.length === 0) {
    throw new Error(
      `parity test: CHECK constraint '${constraintName}' had no quoted values`,
    );
  }
  return values.filter((v): v is string => v !== undefined);
}
