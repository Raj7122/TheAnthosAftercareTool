// P3B-05 — `runAxe(page, label)` helper for the WCAG 2.1 AA gate.
//
// Wraps `@axe-core/playwright`'s `AxeBuilder` with the four WCAG tag sets
// the SAD §6.8 mandate covers (2.0 A/AA + 2.1 A/AA). On any violation, the
// helper throws an Error whose message embeds the full per-rule + per-node
// JSON so a CI failure log carries the exact selector + HTML snippet — no
// need to download the HTML report or attach a trace.
//
// The thrown shape is deliberately structured (id, impact, help, helpUrl,
// nodes[].html, nodes[].target) so the PR body can quote it verbatim as the
// punch list — what the ticket Notes call "treat findings as a punch list".

import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export async function runAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  if (results.violations.length === 0) return;

  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      html: n.html,
      target: n.target,
      failureSummary: n.failureSummary,
    })),
  }));
  throw new Error(
    `[axe:${label}] ${results.violations.length} WCAG 2.1 AA violation(s):\n${JSON.stringify(
      summary,
      null,
      2,
    )}`,
  );
}
