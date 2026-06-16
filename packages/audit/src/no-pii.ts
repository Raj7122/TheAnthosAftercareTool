// No-PII assertions for audit_log.payload_metadata (SEC-AUDIT-4: no message
// content, subject lines, content hashes, or any payload representation).
// Strict by design — a false positive is surfaced to a reviewer (it throws),
// not relaxed here. Runs before the row is built; a PII-bearing payload never
// reaches the database.

import { AuditPiiError } from "./errors.js";

// Key segments that signal PII or forbidden payload content. A key is split on
// snake_case / kebab-case / camelCase boundaries and each segment (plus the
// concatenated whole) is matched — e.g. `participant_name` trips on `name`.
export const PII_KEY_DENYLIST: ReadonlySet<string> = new Set([
  "name",
  "firstname",
  "lastname",
  "fullname",
  "phone",
  "phonenumber",
  "email",
  "emailaddress",
  "address",
  "dob",
  "dateofbirth",
  "ssn",
  "message",
  "body",
  "content",
  "subject",
  "text",
  "note",
  "transcript",
  "summary",
  "hash",
  "contenthash",
  "requesthash",
  "payloadhash",
]);

// Value heuristics. `email-address` and `phone-number` match anywhere in a
// string; `sha256-hash` is anchored to the whole value so 18-char Salesforce
// IDs and 36-char UUIDs (allowed identifiers) are not flagged.
export const PII_VALUE_PATTERNS: ReadonlyArray<{
  rule: string;
  pattern: RegExp;
}> = [
  {
    rule: "email-address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  },
  {
    // NANP shape: optional +1, optional separators/parens, valid area and
    // exchange digits ([2-9]). Digit boundaries keep it from matching inside
    // a longer run (e.g. a 13-digit epoch-millis value). Every quantifier is
    // bounded (`?` / `{n}`), so there is no backtracking risk — safe-regex
    // flags it only because it cannot parse the `(?<!\d)` lookbehind.
    rule: "phone-number",
    // eslint-disable-next-line security/detect-unsafe-regex
    pattern: /(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)/,
  },
  {
    rule: "sha256-hash",
    pattern: /^[a-f0-9]{64}$/i,
  },
];

function keySegments(key: string): string[] {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .toLowerCase()
    .trim()
    .split(" ")
    .filter(Boolean);
  const concatenated = segments.join("");
  return segments.length > 1 ? [...segments, concatenated] : segments;
}

function assertKeyAllowed(key: string, path: string): void {
  for (const segment of keySegments(key)) {
    if (PII_KEY_DENYLIST.has(segment)) {
      throw new AuditPiiError(path, `denied-key:${segment}`);
    }
  }
}

// `numericOnly` skips the email/hash rules for stringified numbers — a number
// can only plausibly carry a phone number.
function scanValue(text: string, path: string, numericOnly: boolean): void {
  for (const { rule, pattern } of PII_VALUE_PATTERNS) {
    if (numericOnly && rule !== "phone-number") {
      continue;
    }
    if (pattern.test(text)) {
      throw new AuditPiiError(path, `value:${rule}`);
    }
  }
}

function walk(value: unknown, path: string): void {
  if (value === null || value === undefined || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    scanValue(value, path, false);
    return;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    scanValue(String(value), path, true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      assertKeyAllowed(key, childPath);
      walk(child, childPath);
    }
  }
}

// Throws AuditPiiError on the first key or value that matches a heuristic.
// Recurses through nested objects and arrays.
export function assertNoPii(payloadMetadata: Record<string, unknown>): void {
  walk(payloadMetadata, "payload_metadata");
}
