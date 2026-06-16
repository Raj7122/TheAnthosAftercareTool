// MSGraphClient — Outlook calendar adapter (P3A-01 / F-12). Creates / updates /
// cancels calendar invites and probes specialist free/busy via Microsoft Graph,
// authenticating with the PF-08 Entra app registration (client-credentials).
//
// DEGRADATION: `fromEnv()` returns `null` when Graph credentials are absent
// (the Demo posture). Callers treat null as "Outlook unavailable" and proceed
// Salesforce-only (outlookEventId = null). The adapter itself never stubs — it
// is a real Graph client that simply isn't constructed when creds are missing.
// In Demo it is therefore dark (built + unit-tested, not exercised live).
//
// PII posture: participant identity never appears in Graph request URLs/query
// strings — URLs carry only the organizer mailbox id and Graph event ids. Error
// categories surface structurally (never silently swallowed) per the API error
// catalog. Graph 401/403/429/5xx map to typed `MsGraphError` codes.

import { resolveMsGraphCredentials, type MsGraphCredentials } from "./capability.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type MsGraphErrorCode =
  | "GRAPH_AUTH_FAILED"
  | "GRAPH_FORBIDDEN"
  | "GRAPH_THROTTLED"
  | "GRAPH_UPSTREAM"
  | "GRAPH_NETWORK_TIMEOUT"
  | "GRAPH_UNKNOWN";

export class MsGraphError extends Error {
  constructor(
    readonly code: MsGraphErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MsGraphError";
  }
}

export interface CreateInviteArgs {
  // Organizer mailbox (specialist) — a Graph user id or UPN. Goes in the URL
  // path; never a participant identifier.
  readonly organizerMailbox: string;
  readonly subject: string;
  readonly startUtc: string; // ISO-8601
  readonly endUtc: string; // ISO-8601
  readonly location?: string;
  // Attendee email addresses (participant + specialist). Sent in the BODY only,
  // never the URL/query string.
  readonly attendeeEmails: ReadonlyArray<string>;
  readonly bodyHtml?: string;
}

export interface FreeBusyArgs {
  readonly mailboxes: ReadonlyArray<string>;
  readonly startUtc: string;
  readonly endUtc: string;
  // Granularity in minutes for the availability view.
  readonly intervalMinutes?: number;
}

export interface BusyInterval {
  readonly startUtc: string;
  readonly endUtc: string;
}

export interface MsGraphClientOptions {
  readonly credentials: MsGraphCredentials;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  // Token acquisition seam (testing) — defaults to the client-credentials grant.
  readonly getToken?: () => Promise<string>;
}

export class MSGraphClient {
  private readonly credentials: MsGraphCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getTokenImpl: () => Promise<string>;

  constructor(options: MsGraphClientOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getTokenImpl = options.getToken ?? (() => this.acquireToken());
  }

  // Returns a live client, or null when Graph credentials are absent (Demo).
  // The capability boolean is the degradation seam — callers branch on null.
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: Omit<MsGraphClientOptions, "credentials"> = {},
  ): MSGraphClient | null {
    const credentials = resolveMsGraphCredentials(env);
    if (credentials === null) return null;
    return new MSGraphClient({ credentials, ...options });
  }

  // Creates an Outlook event on the organizer's calendar and returns the Graph
  // event id. Attendees are invited via the event body, not the URL.
  async createInvite(args: CreateInviteArgs): Promise<{ outlookEventId: string }> {
    const path = `/users/${encodeURIComponent(args.organizerMailbox)}/events`;
    const body = {
      subject: args.subject,
      start: { dateTime: args.startUtc, timeZone: "UTC" },
      end: { dateTime: args.endUtc, timeZone: "UTC" },
      ...(args.location !== undefined ? { location: { displayName: args.location } } : {}),
      ...(args.bodyHtml !== undefined
        ? { body: { contentType: "HTML", content: args.bodyHtml } }
        : {}),
      attendees: args.attendeeEmails.map((email) => ({
        emailAddress: { address: email },
        type: "required",
      })),
    };
    const result = await this.execute<{ id?: string }>("POST", path, body);
    if (typeof result.id !== "string" || result.id.length === 0) {
      throw new MsGraphError("GRAPH_UNKNOWN", "Graph createEvent returned no event id");
    }
    return { outlookEventId: result.id };
  }

  // Updates time/attendees on an existing event.
  async updateInvite(
    organizerMailbox: string,
    eventId: string,
    patch: Partial<Pick<CreateInviteArgs, "startUtc" | "endUtc" | "location">>,
  ): Promise<void> {
    const path = `/users/${encodeURIComponent(organizerMailbox)}/events/${encodeURIComponent(eventId)}`;
    const body: Record<string, unknown> = {};
    if (patch.startUtc !== undefined) body.start = { dateTime: patch.startUtc, timeZone: "UTC" };
    if (patch.endUtc !== undefined) body.end = { dateTime: patch.endUtc, timeZone: "UTC" };
    if (patch.location !== undefined) body.location = { displayName: patch.location };
    await this.execute<unknown>("PATCH", path, body, { allowEmptyBody: true });
  }

  // Cancels an event and sends cancellation notices to attendees.
  async cancelInvite(
    organizerMailbox: string,
    eventId: string,
    comment?: string,
  ): Promise<void> {
    const path = `/users/${encodeURIComponent(organizerMailbox)}/events/${encodeURIComponent(eventId)}/cancel`;
    await this.execute<unknown>(
      "POST",
      path,
      { comment: comment ?? "" },
      { allowEmptyBody: true },
    );
  }

  // Probes busy intervals for the given mailboxes over a window (used by
  // propose-times when Graph is live).
  async getFreeBusy(args: FreeBusyArgs): Promise<Record<string, BusyInterval[]>> {
    const path = `/users/${encodeURIComponent(args.mailboxes[0] ?? "")}/calendar/getSchedule`;
    const body = {
      schedules: args.mailboxes,
      startTime: { dateTime: args.startUtc, timeZone: "UTC" },
      endTime: { dateTime: args.endUtc, timeZone: "UTC" },
      availabilityViewInterval: args.intervalMinutes ?? 30,
    };
    const result = await this.execute<{
      value?: Array<{
        scheduleId?: string;
        scheduleItems?: Array<{ start?: { dateTime?: string }; end?: { dateTime?: string } }>;
      }>;
    }>("POST", path, body);
    const out: Record<string, BusyInterval[]> = {};
    for (const sched of result.value ?? []) {
      const id = sched.scheduleId ?? "";
      // `id` is a mailbox identifier echoed by Graph, used as a result-map key —
      // not attacker-controlled property access.
      // eslint-disable-next-line security/detect-object-injection
      out[id] = (sched.scheduleItems ?? []).flatMap((item) =>
        item.start?.dateTime !== undefined && item.end?.dateTime !== undefined
          ? [{ startUtc: item.start.dateTime, endUtc: item.end.dateTime }]
          : [],
      );
    }
    return out;
  }

  private async acquireToken(): Promise<string> {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.credentials.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new MsGraphError("GRAPH_AUTH_FAILED", "Graph token request failed", res.status);
      }
      const parsed = JSON.parse(text) as { access_token?: string };
      if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
        throw new MsGraphError("GRAPH_AUTH_FAILED", "Graph token response had no access_token");
      }
      return parsed.access_token;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async execute<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    options: { allowEmptyBody?: boolean } = {},
  ): Promise<T> {
    const token = await this.getTokenImpl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchImpl(GRAPH_BASE + path, init);
      const text = await res.text();
      if (!res.ok) {
        throw mapGraphError(res.status, text);
      }
      if (text.length === 0) {
        if (options.allowEmptyBody === true) return null as T;
        throw new MsGraphError("GRAPH_UNKNOWN", "Graph returned an empty body", res.status);
      }
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof MsGraphError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new MsGraphError(
          "GRAPH_NETWORK_TIMEOUT",
          `Graph request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new MsGraphError("GRAPH_UNKNOWN", `Graph request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapGraphError(status: number, _body: string): MsGraphError {
  // Body is intentionally not echoed — it can carry attendee emails (PII).
  if (status === 401) return new MsGraphError("GRAPH_AUTH_FAILED", "Graph rejected the token", status);
  if (status === 403) return new MsGraphError("GRAPH_FORBIDDEN", "Graph denied the operation", status);
  if (status === 429) return new MsGraphError("GRAPH_THROTTLED", "Graph throttled the request", status);
  if (status >= 500) return new MsGraphError("GRAPH_UPSTREAM", "Graph upstream error", status);
  return new MsGraphError("GRAPH_UNKNOWN", `Graph returned status ${status}`, status);
}
