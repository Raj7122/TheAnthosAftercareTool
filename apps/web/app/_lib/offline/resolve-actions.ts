// P3C-12 — local redeclaration of the queue-resolve action tuple.
//
// The canonical wire enum lives in `@anthos/persistence`
// (`schema/offline_queue.ts` — `type ResolutionAction`) and is consumed by
// the BFF through `@anthos/api`'s `QueueResolveRequest` Zod schema. The
// client bundle firewall (memory `feedback_client_bundle_anthos_api.md`)
// forbids value imports from `@anthos/api` or `@anthos/persistence` in
// client code — both pull `pg` into the SPA chunk. Redeclaring the tuple
// here keeps the bundle clean; the parity test
// (`apps/web/test/offline/resolve-actions-parity.test.ts`) asserts the
// local type stays in lockstep with the wire `ResolutionAction` union.

export const RESOLVE_ACTIONS = [
  "DISCARD",
  "REASSIGN_RETRY",
  "ESCALATE_TO_SUPERVISOR",
] as const;

export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

export const RESOLVE_ACTION_LABELS: Readonly<Record<ResolveAction, string>> = {
  DISCARD: "Discard",
  REASSIGN_RETRY: "Reassign and retry",
  ESCALATE_TO_SUPERVISOR: "Escalate to supervisor",
};
