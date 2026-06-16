import { assertSalesforceId } from "./soql.js";
import { SalesforceError, type SalesforceAuth } from "./types.js";

// Thin REST + SOQL wrapper over `fetch`. The adapter owns governor-limit
// posture, structured error mapping, and request timeouts (SAD §12.1: 10s
// default). Token + instance URL come from `SalesforceAuth` per call so a
// rotation never leaves the client holding a stale credential.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_API_VERSION = "v67.0";

export interface SoqlQueryResponse<T> {
  readonly totalSize: number;
  readonly done: boolean;
  readonly nextRecordsUrl?: string;
  readonly records: ReadonlyArray<T>;
}

export interface CompositeSubResponse<T> {
  readonly statusCode: number;
  readonly result: SoqlQueryResponse<T> | { message?: string; errorCode?: string };
}

export interface CompositeBatchResponse {
  readonly hasErrors: boolean;
  readonly results: ReadonlyArray<CompositeSubResponse<unknown>>;
}

// Salesforce DML create response body — `POST /sobjects/{type}/` returns
// `{ id, success, errors[] }`. Treat anything other than `success: true` with
// a non-empty `id` as an SF_UNKNOWN — Salesforce should already have flagged
// failures via a 4xx, but the contract is belt-and-braces.
export interface CreateRecordResult {
  readonly id: string;
  readonly success: boolean;
  readonly errors: ReadonlyArray<unknown>;
}

// One element of the Invocable-Actions REST response array (per-invocation).
// `outputValues` carries the Flow's output variables (e.g. the created
// EmailMessage / Task id); `errors` is populated only when `isSuccess` is false.
export interface FlowInvocationResult {
  readonly isSuccess: boolean;
  readonly outputValues: Record<string, unknown>;
  readonly errors: ReadonlyArray<{
    readonly statusCode?: string;
    readonly message?: string;
  }> | null;
}

export interface RestClientOptions {
  readonly auth: SalesforceAuth;
  readonly apiVersion?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class SalesforceRestClient {
  private readonly auth: SalesforceAuth;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private requestCount = 0;

  constructor(options: RestClientOptions) {
    this.auth = options.auth;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get roundTripCount(): number {
    return this.requestCount;
  }

  // Single SOQL query (no pagination follow-up). Use `queryAll` when the
  // caller expects >2000 rows. Caller is responsible for typing the records.
  async query<T>(soql: string): Promise<SoqlQueryResponse<T>> {
    const instanceUrl = await this.auth.getInstanceUrl();
    const path = `/services/data/${this.apiVersion}/query?q=${encodeURIComponent(soql)}`;
    return this.execute<SoqlQueryResponse<T>>("GET", instanceUrl + path);
  }

  // Pagination-aware query. Follows `nextRecordsUrl` until done — each follow-
  // up is its own round-trip. TR-SF-2 cost-validation should run on the
  // largest realistic caseload to confirm pagination doesn't fire.
  async queryAll<T>(soql: string): Promise<SoqlQueryResponse<T>> {
    const instanceUrl = await this.auth.getInstanceUrl();
    let page = await this.execute<SoqlQueryResponse<T>>(
      "GET",
      instanceUrl + `/services/data/${this.apiVersion}/query?q=${encodeURIComponent(soql)}`,
    );
    const accumulated: T[] = [...page.records];
    while (!page.done && typeof page.nextRecordsUrl === "string") {
      page = await this.execute<SoqlQueryResponse<T>>(
        "GET",
        instanceUrl + page.nextRecordsUrl,
      );
      accumulated.push(...page.records);
    }
    return {
      totalSize: accumulated.length,
      done: true,
      records: accumulated,
    };
  }

  // Composite batch — one HTTP round-trip for up to 25 SOQL sub-queries.
  // TR-SF-2 single-round-trip budget for the child-collection fetch relies
  // on this; without composite batch we would need one round-trip per
  // sibling object (Case Notes + Barriers + Incidents = 3 round-trips).
  //
  // CAVEAT: composite-batch sub-results do NOT auto-paginate. If a child
  // collection exceeds 2000 rows, the response is silently truncated for
  // that sub-query. Cost-validation
  // confirmed this is not a concern at the TR-SF-2 75-participant scale on
  // the anonymized sandbox today. Phase 1 / Production scale-up should add
  // explicit per-sub-result follow-up via `nextRecordsUrl` (which would
  // exceed TR-SF-2's ≤2 round-trip budget under load and require a spec
  // amendment).
  async compositeBatch(
    subQueries: ReadonlyArray<string>,
  ): Promise<CompositeBatchResponse> {
    if (subQueries.length === 0) {
      return { hasErrors: false, results: [] };
    }
    if (subQueries.length > 25) {
      throw new SalesforceError(
        "SF_GOVERNOR_LIMIT",
        `compositeBatch supports up to 25 sub-queries; got ${subQueries.length}`,
      );
    }
    const instanceUrl = await this.auth.getInstanceUrl();
    const body = {
      batchRequests: subQueries.map((q) => ({
        method: "GET",
        url: `${this.apiVersion}/query?q=${encodeURIComponent(q)}`,
      })),
    };
    return this.execute<CompositeBatchResponse>(
      "POST",
      instanceUrl + `/services/data/${this.apiVersion}/composite/batch`,
      body,
    );
  }

  // DML create — POSTs the supplied fields to /sobjects/{sobjectType}/. The
  // caller passes the SF API names exactly (e.g. `Type__c`, `Stage__c`); the
  // adapter does not transform field names. On success Salesforce returns
  // `{ id, success: true, errors: [] }`; failures surface as 4xx with the
  // standard `[{ errorCode, message }]` body (mapped by `mapHttpError`).
  // Identifier is sobject-shape-validated up-front to keep URL construction
  // injection-safe — the same guard `query` relies on for SOQL.
  async createRecord<T extends Record<string, unknown>>(
    sobjectType: string,
    fields: T,
  ): Promise<CreateRecordResult> {
    assertSObjectIdentifier(sobjectType);
    const instanceUrl = await this.auth.getInstanceUrl();
    const path = `/services/data/${this.apiVersion}/sobjects/${sobjectType}/`;
    const result = await this.execute<CreateRecordResult>(
      "POST",
      instanceUrl + path,
      fields,
    );
    if (!result.success || typeof result.id !== "string" || result.id.length === 0) {
      throw new SalesforceError(
        "SF_UNKNOWN",
        `Salesforce returned success=${String(result.success)} with id=${String(result.id)}`,
      );
    }
    return result;
  }

  // DML update — PATCHes the supplied fields to /sobjects/{sobjectType}/{id}.
  // Salesforce returns 204 No Content on success, so this method resolves to
  // void and `execute` is asked to tolerate an empty body. URL is guarded on
  // both sides — `sobjectType` via `assertSObjectIdentifier`, `recordId` via
  // `assertSalesforceId` — keeping the path injection-safe. Error mapping is
  // identical to `createRecord` (DML 4xx codes apply to PATCH the same way).
  async updateRecord<T extends Record<string, unknown>>(
    sobjectType: string,
    recordId: string,
    fields: T,
  ): Promise<void> {
    assertSObjectIdentifier(sobjectType);
    assertSalesforceId(recordId, "recordId");
    const instanceUrl = await this.auth.getInstanceUrl();
    const path = `/services/data/${this.apiVersion}/sobjects/${sobjectType}/${recordId}`;
    await this.execute<null>("PATCH", instanceUrl + path, fields, {
      allowEmptyBody: true,
    });
  }

  // Invocable-Actions REST — runs a tool-owned **autolaunched** Flow by API
  // name (TRD v1.9 §: outbound email is sent by invoking a dedicated tool-owned
  // Salesforce Flow via `POST /services/data/{v}/actions/custom/flow/{name}`).
  // The Actions API wraps inputs as `{ inputs: [ {...} ] }` and returns an
  // array of per-invocation results `{ isSuccess, outputValues, errors }`. We
  // send a single invocation and return its result; a non-success element maps
  // to `SF_VALIDATION_FAILED` (the Flow rejected the inputs) so handlers render
  // it the same way a DML validation failure surfaces.
  //
  // NOTE (GAP-8, resolved 2026-05-17): the Actions API does NOT index *screen*
  // flows — only autolaunched flows are invocable here. The tool-owned email
  // Flow MUST therefore be autolaunched. Screen-flow REST is not viable; the
  // visit-logging path uses direct sObject writes instead.
  async invokeFlow(
    flowApiName: string,
    inputs: Record<string, unknown>,
  ): Promise<FlowInvocationResult> {
    assertSObjectIdentifier(flowApiName);
    const instanceUrl = await this.auth.getInstanceUrl();
    const path = `/services/data/${this.apiVersion}/actions/custom/flow/${flowApiName}`;
    const result = await this.execute<ReadonlyArray<FlowInvocationResult>>(
      "POST",
      instanceUrl + path,
      { inputs: [inputs] },
    );
    const first = Array.isArray(result) ? result[0] : undefined;
    if (first === undefined) {
      throw new SalesforceError(
        "SF_UNKNOWN",
        "Flow invocation returned no result element",
      );
    }
    if (!first.isSuccess) {
      const firstError = first.errors?.[0];
      throw new SalesforceError(
        "SF_VALIDATION_FAILED",
        firstError?.message ?? "Flow invocation reported failure",
        undefined,
        firstError?.statusCode,
      );
    }
    return first;
  }

  private async execute<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    body?: unknown,
    options: { allowEmptyBody?: boolean } = {},
  ): Promise<T> {
    this.requestCount += 1;
    const accessToken = await this.auth.getAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const response = await this.fetchImpl(url, init);
      const text = await response.text();
      if (!response.ok) {
        throw mapHttpError(response.status, text);
      }
      if (text.length === 0) {
        // PATCH /sobjects/{type}/{id} returns 204 on success — callers opt
        // into the empty body via `allowEmptyBody`. Read-shaped endpoints
        // (query / queryAll / composite / createRecord) keep the strict
        // posture because Salesforce always returns a body for them.
        if (options.allowEmptyBody === true) {
          return null as T;
        }
        throw new SalesforceError(
          "SF_UNKNOWN",
          "Salesforce returned an empty body on a successful response",
          response.status,
        );
      }
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof SalesforceError) {
        throw err;
      }
      if ((err as { name?: string }).name === "AbortError") {
        throw new SalesforceError(
          "SF_NETWORK_TIMEOUT",
          `Salesforce request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new SalesforceError(
        "SF_UNKNOWN",
        `Salesforce request failed: ${(err as Error).message ?? "unknown"}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Maps Salesforce error payloads to our structured codes. Salesforce returns
// a JSON array of `{ errorCode, message }` objects for 4xx/5xx responses; we
// keep the first errorCode + message but never echo SOQL text (it can carry
// SF Ids — Pattern B PII firewall posture).
function mapHttpError(status: number, body: string): SalesforceError {
  const { errorCode, message } = parseSalesforceErrorBody(body);
  const rawCode = errorCode ?? undefined;
  if (status === 401) {
    return new SalesforceError(
      "SF_AUTH_FAILED",
      "Salesforce rejected the access token; re-run `sf org login web`",
      status,
      rawCode,
    );
  }
  // SOQL-read FLS denial returns INSUFFICIENT_FIELD_PERMISSIONS (400-level
  // error body). DML-path denial returns INVALID_FIELD_FOR_INSERT_UPDATE
  // (403). Both surface to callers as SF_FIELD_FLS_DENIED so the
  // bulk-hydration integration test can skip gracefully on a sandbox
  // missing FLS grants without losing the auth/quota/governor signal.
  if (errorCode === "INSUFFICIENT_FIELD_PERMISSIONS") {
    return new SalesforceError("SF_FIELD_FLS_DENIED", message, status, rawCode);
  }
  if (errorCode === "INSUFFICIENT_ACCESS_OR_READONLY") {
    // DML-side FLS / object-permission denial — Salesforce returns this when
    // the integration user lacks Create/Update on the record. Surfaces to the
    // caller the same way SOQL FLS denial does so handlers map one error code.
    return new SalesforceError("SF_FIELD_FLS_DENIED", message, status, rawCode);
  }
  if (status === 403 && errorCode === "INVALID_FIELD_FOR_INSERT_UPDATE") {
    return new SalesforceError("SF_FIELD_FLS_DENIED", message, status, rawCode);
  }
  if (status === 429) {
    return new SalesforceError("SF_QUOTA_EXCEEDED", message, status, rawCode);
  }
  // Ownership / state changed mid-write — P1F-03b. SF returns
  // INVALID_CROSS_REFERENCE_KEY when a referenced record is no longer
  // accessible (caseload reassignment) and ENTITY_IS_DELETED when the target
  // is soft-deleted. Both flow to callers as SF_UPSTREAM_STATE_CHANGED so
  // handlers can render 409 UPSTREAM_STATE_CHANGED with a per-code
  // `suggestedResolution` envelope (API v1.3 §7.4.3 line 940 / §9.2.1 line
  // 2172). Status-agnostic — SF returns these under both 400 and 404.
  if (
    errorCode === "INVALID_CROSS_REFERENCE_KEY" ||
    errorCode === "ENTITY_IS_DELETED"
  ) {
    return new SalesforceError(
      "SF_UPSTREAM_STATE_CHANGED",
      message,
      status,
      rawCode,
    );
  }
  if (status === 400) {
    if (errorCode === "INVALID_QUERY_LOCATOR") {
      return new SalesforceError("SF_GOVERNOR_LIMIT", message, status, rawCode);
    }
    if (errorCode === "INVALID_FIELD" || errorCode === "MALFORMED_QUERY") {
      return new SalesforceError("SF_QUERY_INVALID", message, status, rawCode);
    }
    // DML validation rejections — SF returns 400 with these codes when the
    // payload is structurally accepted but a record rule (required field,
    // length cap, picklist value, custom validation) fails (P1E-01).
    if (
      errorCode === "REQUIRED_FIELD_MISSING" ||
      errorCode === "STRING_TOO_LONG" ||
      errorCode === "INVALID_TYPE_ON_FIELD_IN_RECORD" ||
      errorCode === "FIELD_CUSTOM_VALIDATION_EXCEPTION" ||
      errorCode === "FIELD_INTEGRITY_EXCEPTION"
    ) {
      return new SalesforceError(
        "SF_VALIDATION_FAILED",
        message,
        status,
        rawCode,
      );
    }
  }
  return new SalesforceError("SF_UNKNOWN", message, status, rawCode);
}

// SObject API names are `[A-Za-z][A-Za-z0-9_]*`, optionally ending with `__c`
// for custom objects. Validating here keeps `${instanceUrl}/.../sobjects/X/`
// URL construction injection-safe — the same posture `escapeSoqlString`
// applies to SOQL string literals.
function assertSObjectIdentifier(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new SalesforceError(
      "SF_UNKNOWN",
      `Invalid Salesforce sobject identifier: ${value}`,
    );
  }
}

function parseSalesforceErrorBody(body: string): {
  errorCode: string | null;
  message: string;
} {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as { errorCode?: string; message?: string };
      return {
        errorCode: first.errorCode ?? null,
        message: first.message ?? "Salesforce returned an error",
      };
    }
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as { errorCode?: string; message?: string };
      return {
        errorCode: obj.errorCode ?? null,
        message: obj.message ?? "Salesforce returned an error",
      };
    }
  } catch {
    // fall through to generic message
  }
  return { errorCode: null, message: "Salesforce returned an error" };
}
