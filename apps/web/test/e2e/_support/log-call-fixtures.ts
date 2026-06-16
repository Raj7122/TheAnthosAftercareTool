// P1F-06 — Helpers for the F-08 Log-a-Call tap-to-submit perf E2E. Pure
// math + DOM-action helpers; no Playwright server-side state. The asserted
// `log-call-perf.e2e.ts` and the opt-in `log-call-perf.live.e2e.ts` both
// consume these so the iteration loop and per-stage aggregation logic stay
// in one place.

import { expect, type Page } from "@playwright/test";

// One-iteration sample: end-to-end wall-clock from menu tap to dialog
// detach, plus the per-stage breakdown read off the page's
// `PerformanceMark` entries.
//
// `stages` keys mirror the marks set in the SPA (CaseloadView.tsx +
// LogCallSheet.tsx + reconcile-log-call.ts):
//   open_to_submit          — sheet open → submit click (specialist fill)
//   submit_to_optimistic    — submit click → optimistic insert dispatched
//   optimistic_to_network   — optimistic insert → BFF round-trip starts
//   network_round_trip      — BFF send start → BFF send end
//   network_to_reconciled   — BFF response → canonical replace dispatched
//   reconciled_to_closed    — canonical replace → sheet detach
export interface LogCallPerfSample {
  readonly iteration: number;
  readonly participantId: string;
  readonly wallMs: number;
  readonly stages: LogCallPerfStages;
}

export interface LogCallPerfStages {
  readonly open_to_submit: number | null;
  readonly submit_to_optimistic: number | null;
  readonly optimistic_to_network: number | null;
  readonly network_round_trip: number | null;
  readonly network_to_reconciled: number | null;
  readonly reconciled_to_closed: number | null;
}

// Drives one tap-to-submit iteration against the rendered caseload. Returns
// the wall-clock duration; the caller pairs it with `readStagesFromPage` to
// build the full sample. The function:
//
//   1. clicks the row's inline "Log Call" QuickActionsRow button
//      (P1H-05 replaced the OverflowMenu with always-visible icon buttons);
//      sets `logcall:sheet:open`;
//   2. waits for the dialog to render and the Summary field to be present;
//   3. pre-fills Summary via `locator.fill` (paste-style — instant; satisfies
//      AC-30 "excluding summary text entry time");
//   4. clicks the dynamic-label submit button "Log call for <participant>"
//      (display name, or the SF id when no name is resolved — matched by prefix);
//   5. waits for the dialog to detach (the canonical-2xx signal that closes
//      the sheet; on terminal failure the sheet would stay open and the
//      expect would correctly fail the iteration).
//
// `summaryText` defaults to a benign sentence — never PII, well under
// SUMMARY_MAX_LEN, and short enough that any future Status='Completed'
// variant would still satisfy VR-18's ≥10-char minimum (though this loop
// uses 'Attempted', where summary is optional).
export async function runOneIteration(
  page: Page,
  participantId: string,
  summaryText: string = DEFAULT_SAMPLE_SUMMARY,
): Promise<number> {
  // Clear the marks from any prior iteration so reads only see this run.
  await page.evaluate(() => {
    // `clearMarks()` with no argument removes every PerformanceMark; the
    // per-stage measurement only cares about `logcall:*` marks but cheap to
    // clear the whole namespace per iteration.
    performance.clearMarks();
  });

  const startWall = Date.now();

  // P1H-05 removed the OverflowMenu; the QuickActionsRow now exposes
  // Log Call as an always-visible inline button. The button's aria-label
  // is "Log Call" globally — scope to the row to keep the selector unique
  // across the 75-row caseload. (P1H-06: rows are `<tr data-testid=
  // "caseload-row">` inside the table; the `has:` locator filters to the
  // row containing this participant's BR-41 link.)
  await page
    .locator(`[data-testid="caseload-row"]`, {
      has: page.locator(`a[href="/participants/${participantId}"]`),
    })
    .getByRole("button", { name: "Log Call" })
    .click();

  // Wait for the sheet's Summary textarea to render before filling. The
  // dialog mount happens synchronously after `setLogCallSheet`, but the
  // explicit wait absorbs React's commit cycle without timing it (the
  // perf budget is for the BFF round-trip + reconcile, not React paint).
  const summary = page.getByLabel(/^Summary/);
  await summary.waitFor({ state: "visible" });
  await summary.fill(summaryText);

  // The submit label is `Log call for <participant>` where <participant> is the
  // resolved display name, falling back to the SF id when no name is resolved
  // (warm fixture rows ship `displayName: null`, so this is the id here). Match
  // the stable prefix so the selector survives either form.
  await page
    .getByRole("button", { name: /^Log call for / })
    .click();

  // Dialog detach is the "submit confirmation visible" signal per AC-30.
  // The sheet only closes on canonical 2xx (CaseloadView.handleLogCallSubmit
  // success branch). A terminal failure keeps the sheet open with a banner,
  // and this expect would fail — surfacing the regression rather than
  // silently logging a fast median.
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 35_000 });

  return Date.now() - startWall;
}

// Reads the SPA's PerformanceMark entries for the current iteration and
// computes per-stage durations. `null` for a stage means the corresponding
// mark pair was incomplete (e.g., the iteration didn't reach reconcile),
// which would be a regression signal in itself.
export async function readStagesFromPage(page: Page): Promise<LogCallPerfStages> {
  return page.evaluate((): LogCallPerfStages => {
    function startOf(name: string): number | null {
      const entries = performance.getEntriesByName(name, "mark");
      return entries.length === 0 ? null : entries[entries.length - 1]!.startTime;
    }
    function span(a: string, b: string): number | null {
      const x = startOf(a);
      const y = startOf(b);
      if (x === null || y === null) return null;
      return y - x;
    }
    return {
      open_to_submit: span("logcall:sheet:open", "logcall:submit:start"),
      submit_to_optimistic: span(
        "logcall:submit:start",
        "logcall:optimistic:applied",
      ),
      optimistic_to_network: span(
        "logcall:optimistic:applied",
        "logcall:network:start",
      ),
      network_round_trip: span("logcall:network:start", "logcall:network:end"),
      network_to_reconciled: span("logcall:network:end", "logcall:reconciled"),
      reconciled_to_closed: span("logcall:reconciled", "logcall:sheet:closed"),
    };
  });
}

// `Math.median` over a non-empty number array. For an even-length array,
// uses the lower-mid + upper-mid average per the conventional definition
// (matches what perf engineers expect when they say "p50"). Throws on an
// empty input so the test's failure mode is obvious rather than silently
// asserting `NaN <= 30000`.
export function computeMedian(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) {
    throw new Error("computeMedian: empty samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index into locally-sorted array
    return sorted[mid]!;
  }
  // eslint-disable-next-line security/detect-object-injection -- numeric index into locally-sorted array
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Per-stage medians across all samples. Stages with any-null samples are
// summarized over the non-null subset; if every sample is null the entry
// is `null`. Used only for diagnostic logging — the load-bearing assertion
// is on `wallMs`.
export function computeStageMedians(
  samples: ReadonlyArray<LogCallPerfSample>,
): Record<keyof LogCallPerfStages, number | null> {
  const keys: Array<keyof LogCallPerfStages> = [
    "open_to_submit",
    "submit_to_optimistic",
    "optimistic_to_network",
    "network_round_trip",
    "network_to_reconciled",
    "reconciled_to_closed",
  ];
  const out: Record<keyof LogCallPerfStages, number | null> = {
    open_to_submit: null,
    submit_to_optimistic: null,
    optimistic_to_network: null,
    network_round_trip: null,
    network_to_reconciled: null,
    reconciled_to_closed: null,
  };
  for (const key of keys) {
    const values = samples
      // eslint-disable-next-line security/detect-object-injection -- key constrained to the typed `keys` literal union
      .map((s) => s.stages[key])
      .filter((v): v is number => v !== null);
    // eslint-disable-next-line security/detect-object-injection -- key constrained to the typed `keys` literal union
    out[key] = values.length === 0 ? null : computeMedian(values);
  }
  return out;
}

// Benign synthetic summary text — never PII. Short, but well over the
// VR-18 ≥10-char minimum so a future variant that exercises
// Status='Completed' could reuse it without revisiting this constant.
export const DEFAULT_SAMPLE_SUMMARY =
  "Routine aftercare check-in — perf test sample.";
