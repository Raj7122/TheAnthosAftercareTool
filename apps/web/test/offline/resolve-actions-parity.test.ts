// P3C-12 — parity gate between the SPA-local `RESOLVE_ACTIONS` tuple
// (`apps/web/app/_lib/offline/resolve-actions.ts`) and the wire-side
// `QueueResolveRequest["action"]` union exported from `@anthos/api`.
//
// The wire schema (Zod `z.enum(RESOLVE_ACTIONS, ...)` in
// `packages/api/src/queue/dto.ts`) projects through the persistence-layer
// `ResolutionAction` union. Routing through `@anthos/api` avoids adding
// `@anthos/persistence` as a dependency to apps/web — type-imports only,
// matching the client bundle firewall (memory
// `feedback_client_bundle_anthos_api.md`).

import { describe, expect, it } from "vitest";

import type { QueueResolveRequest } from "@anthos/api";

import {
  RESOLVE_ACTIONS,
  type ResolveAction,
} from "../../app/_lib/offline/resolve-actions";

type WireAction = QueueResolveRequest["action"];

type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

// Compile-time parity — fails `pnpm typecheck` if either side gains or
// drops a member.
const _assertParity: AssertEqual<ResolveAction, WireAction> = true;
void _assertParity;

describe("resolve-actions parity (RESOLVE_ACTIONS ⇄ QueueResolveRequest['action'])", () => {
  it("contains exactly the three Pattern E actions", () => {
    expect([...RESOLVE_ACTIONS].sort()).toEqual([
      "DISCARD",
      "ESCALATE_TO_SUPERVISOR",
      "REASSIGN_RETRY",
    ]);
  });

  it("declares DISCARD first so it is the default-fallback action", () => {
    expect(RESOLVE_ACTIONS[0]).toBe("DISCARD");
  });
});
