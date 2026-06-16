// SOQL string escaping for adapter-built queries. The adapter never accepts
// raw user input into SOQL — only specialist/owner Salesforce Ids — but we
// still escape defensively: an Id-shaped value can carry quote-injection in
// pathological cases, and tightening this here means future write-path code
// inherits a single, audited escape function.

const SOQL_STRING_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "'": "\\'",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
  '"': '\\"',
};

export function escapeSoqlString(value: string): string {
  return value.replace(/[\\'\n\r\t\b\f"]/g, (ch) => SOQL_STRING_ESCAPES[ch] ?? ch);
}

// Salesforce record Ids are 15- or 18-char alphanumeric. Validating before
// interpolation prevents both injection and accidental query corruption.
const SF_ID_PATTERN = /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/;

export function assertSalesforceId(value: string, fieldLabel: string): void {
  if (!SF_ID_PATTERN.test(value)) {
    throw new Error(`${fieldLabel} is not a valid Salesforce Id: ${value.length} chars`);
  }
}

// Build a quoted, comma-separated Id list for `WHERE Field IN (...)` clauses.
// Each Id is validated; the list is empty-rejected by the caller.
export function buildIdInClause(ids: ReadonlyArray<string>): string {
  return ids
    .map((id) => {
      assertSalesforceId(id, "Salesforce Id");
      return `'${id}'`;
    })
    .join(",");
}
