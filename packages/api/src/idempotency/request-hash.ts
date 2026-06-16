// Request-hash binding (API §8.4, ERD §6.2). The BFF stores
// SHA-256(method + path + canonical_json(body)) with the idempotency row; a
// replay that reuses the key with a different body is rejected (422) rather
// than masked as a safe replay.

import { createHash } from "node:crypto";

// Deterministic JSON serialization: object keys sorted recursively so that
// key order and insignificant whitespace do not change the hash. A body that
// is not valid JSON is hashed as its raw text.
export function canonicalJson(bodyText: string): string {
  if (bodyText.length === 0) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  return stableStringify(parsed);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function computeRequestHash(
  method: string,
  pathname: string,
  bodyText: string,
): string {
  const canonical = `${method}\n${pathname}\n${canonicalJson(bodyText)}`;
  return createHash("sha256").update(canonical).digest("hex");
}
