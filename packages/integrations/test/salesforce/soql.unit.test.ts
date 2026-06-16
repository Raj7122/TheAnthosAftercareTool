import { describe, expect, it } from "vitest";

import {
  assertSalesforceId,
  buildIdInClause,
  escapeSoqlString,
} from "../../src/salesforce/soql.js";

describe("escapeSoqlString", () => {
  it("escapes backslashes and single quotes", () => {
    expect(escapeSoqlString("a'b\\c")).toBe("a\\'b\\\\c");
  });

  it("escapes newline and tab characters that would break the SOQL literal", () => {
    expect(escapeSoqlString("line1\nline2\ttab")).toBe("line1\\nline2\\ttab");
  });

  it("is a no-op for clean strings", () => {
    expect(escapeSoqlString("Marie Alcis")).toBe("Marie Alcis");
  });
});

describe("assertSalesforceId", () => {
  it("accepts 15- and 18-char alphanumeric Ids", () => {
    expect(() => assertSalesforceId("0035g00000ABCDE", "x")).not.toThrow();
    expect(() => assertSalesforceId("0035g00000ABCDEAA1", "x")).not.toThrow();
  });

  it("rejects an Id with a hyphen", () => {
    expect(() => assertSalesforceId("not-a-real-id", "ownerId")).toThrow(
      /ownerId is not a valid Salesforce Id/,
    );
  });

  it("rejects an empty string", () => {
    expect(() => assertSalesforceId("", "ownerId")).toThrow();
  });
});

describe("buildIdInClause", () => {
  it("quotes and joins valid Ids", () => {
    expect(
      buildIdInClause(["0035g00000ABCDEAA1", "0035g00000XYZ12AA1"]),
    ).toBe("'0035g00000ABCDEAA1','0035g00000XYZ12AA1'");
  });

  it("propagates the assertion failure if any Id is invalid", () => {
    expect(() =>
      buildIdInClause(["0035g00000ABCDEAA1", "bogus"]),
    ).toThrow(/not a valid Salesforce Id/);
  });
});
