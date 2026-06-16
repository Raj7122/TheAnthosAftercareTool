// Specialist/Supervisor/VP/SystemAdmin roles per ERD §6.8 sessions CHECK
// constraint. Used by BR-13 admin-gating on M-CONFIG mutations and by every
// future role-gated surface (impl plan §7 packages/auth/src/roles.ts).
import { createHash } from "node:crypto";

export const ROLES = ["SPECIALIST", "SUPERVISOR", "VP", "SYSTEM_ADMIN"] as const;

export type Role = (typeof ROLES)[number];

export interface Actor {
  readonly id: string;
  readonly role: Role;
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// BR-13: configuration mutations are admin-only.
export function isAdmin(role: Role): boolean {
  return role === "SYSTEM_ADMIN";
}

// Stable hash of a specialist's role+scope, surfaced by `GET /me` as
// `permissionsHash` (API §7.2.5). The SPA stores it and invalidates cached
// Salesforce data when it changes — the EC-02 mid-session permission-set
// change signal. In the four-role model read/write scope is fully determined
// by `role` (API §8.3.1), so hashing `specialistId` + `role` is a faithful
// "hash of role+scope": it is stable for a given specialist while their role
// holds, and changes exactly when their role does. Deterministic and pure.
export function computePermissionsHash(specialistId: string, role: Role): string {
  const digest = createHash("sha256")
    .update(`${specialistId}\n${role}`, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
