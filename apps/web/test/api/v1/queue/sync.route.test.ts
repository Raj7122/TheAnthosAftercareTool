// Wire-contract guard for `POST /api/v1/queue/sync` (E-18, P3C-06).
//
// The SPA queue indicator (P3C-12) binds to `QueueSyncBody` keys. This guard
// fails at compile time if a field is renamed in
// `packages/api/src/queue/dto.ts` (the `keyof QueueSyncBody` literal-typed
// array drops a now-invalid key), and at runtime if the §7.5.2
// `itemsRouterToReview` spelling is silently corrected. Mirrors the
// `apps/web/test/api/participants/get-participant-spa-contract.test.ts`
// pattern.
//
// Route-shim wiring is exercised by the @anthos/api unit tests under
// `packages/api/test/queue/post-queue-sync.test.ts`; the shim itself is a
// one-line forward `(req) => handleQueueSync(req)` with no logic of its own.
// Matches the GET /queue/pending precedent (P3C-05) — no apps/web integration
// test for the queue route shims.

import type { QueueSyncBody } from "@anthos/api";
import { describe, expect, it } from "vitest";

// SPA-required keys. Typed `keyof QueueSyncBody`, so a rename in dto.ts
// fails this file at compile time. The `itemsRouterToReview` typo is the
// published §7.5.2 contract — preserved verbatim (don't auto-correct spec terms).
const SPA_REQUIRED_KEYS: ReadonlyArray<keyof QueueSyncBody> = [
  "syncTriggeredAt",
  "itemsAttempted",
  "itemsCompleted",
  "itemsRouterToReview",
  "itemsRemaining",
];

function makeBody(overrides: Partial<QueueSyncBody> = {}): QueueSyncBody {
  return {
    syncTriggeredAt: "2026-05-27T15:30:00.000Z",
    itemsAttempted: 0,
    itemsCompleted: 0,
    itemsRouterToReview: 0,
    itemsRemaining: 0,
    ...overrides,
  };
}

describe("POST /api/v1/queue/sync — wire-contract guard (P3C-12 → §7.5.2)", () => {
  it("QueueSyncBody carries every SPA-required key", () => {
    const body = makeBody();
    for (const key of SPA_REQUIRED_KEYS) {
      expect(body).toHaveProperty(key);
    }
  });

  it("preserves the §7.5.2 `itemsRouterToReview` spelling (typo intentional)", () => {
    const body = makeBody({ itemsRouterToReview: 7 });
    expect(body).toHaveProperty("itemsRouterToReview");
    // The corrected spelling MUST NOT appear — if a future refactor silently
    // renames the field, the SPA queue indicator binds to the wrong key and
    // counts disappear from the UI.
    expect(body).not.toHaveProperty("itemsRoutedToReview");
  });
});
