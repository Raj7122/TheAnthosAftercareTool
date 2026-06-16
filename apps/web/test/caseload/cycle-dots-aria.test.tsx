// P3B-05 — `CycleDots` renders `role="img"` on every announceable
// container so the `aria-label` is permitted by ARIA (4.1.2 /
// `aria-prohibited-attr`).
//
// Without the role, axe-core's `aria-prohibited-attr` rule flags a bare
// `<span aria-label="...">` as a WCAG 2.1 AA violation; the demo-path E2E
// caught it on every caseload row (one violation per per-anchor dot × 75
// rows). This test pins the fix at the unit level so a future edit that
// drops the role re-fails here before it reaches the slower E2E gate.
//
// Vitest's `environment: "node"` is fine — `renderToStaticMarkup` runs
// without a DOM and gives us the raw markup to assert against.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CycleDots } from "../../app/_components/participant/CycleDots";

describe("CycleDots — P3B-05 ARIA role coverage", () => {
  it('renders role="img" on every per-anchor dot so aria-label is permitted', () => {
    const html = renderToStaticMarkup(
      <CycleDots
        perCheckpointBreakdown={[
          { anchor: 90, state: "complete" },
          { anchor: 180, state: "due" },
          { anchor: 270, state: "overdue" },
          { anchor: 365, state: "future" },
        ]}
      />,
    );
    // Four announceable spans — one per anchor — each carrying role="img".
    // Using a literal-count assertion (not >=) so an accidental extra
    // unlabeled span in the future also fails the test.
    const roleImgCount = (html.match(/role="img"/g) ?? []).length;
    expect(roleImgCount).toBe(4);
    // Each anchor's per-checkpoint aria-label still rides on its own role=img
    // container — the "one announcement per anchor" UX is preserved.
    expect(html).toContain('aria-label="90-day checkpoint: complete"');
    expect(html).toContain('aria-label="365-day checkpoint: future"');
  });

  it('renders role="img" + a single aria-label on the degraded-path container', () => {
    const html = renderToStaticMarkup(<CycleDots perCheckpointBreakdown={[]} />);
    // The degraded path collapses the four dots into one labeled container
    // ("Stability cycle unknown") — exactly one role="img" + matching label.
    const roleImgCount = (html.match(/role="img"/g) ?? []).length;
    expect(roleImgCount).toBe(1);
    expect(html).toContain('aria-label="Stability cycle unknown"');
    // The four placeholder spans are aria-hidden — the screen reader hears
    // the parent label only.
    const ariaHiddenCount = (html.match(/aria-hidden="true"/g) ?? []).length;
    expect(ariaHiddenCount).toBe(4);
  });
});
