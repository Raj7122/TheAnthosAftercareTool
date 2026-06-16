// @vitest-environment happy-dom

// The participant-timeline repair row is a disclosure: collapsed it shows only
// "Repair logged at <date>" (never the note); expanding reveals the note. This
// locks requirement #5 — the note is hidden until the specialist opts in.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecentContactsTimeline } from "../../app/participants/[id]/_components/RecentContactsTimeline";
import type { OptimisticRepair } from "../../app/_components/repairs/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const REPAIR: OptimisticRepair = {
  repairId: "a1J5g00000REPxQAO",
  participantId: "a015g00000ABCDxQAO",
  participantName: "Marie Alcis",
  identificationDate: "2026-06-04",
  note: "Kitchen faucet leaking steadily",
  loggedAt: "2026-06-04T15:30:00.000Z",
};

function renderTimeline() {
  act(() => {
    root.render(
      <RecentContactsTimeline recentContacts={[]} repairs={[REPAIR]} />,
    );
  });
}

describe("RecentContactsTimeline — repair disclosure row", () => {
  it("collapsed: shows 'Repair logged at <date>' and hides the note", () => {
    renderTimeline();
    const trigger = container.querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Repair logged at");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");

    const panel = document.getElementById(
      trigger!.getAttribute("aria-controls")!,
    )!;
    // Note text is present in the DOM but the panel is hidden until expanded.
    expect(panel.hidden).toBe(true);
    // The collapsed trigger itself must not leak the note.
    expect(trigger!.textContent).not.toContain("Kitchen faucet leaking");
  });

  it("expands on click to reveal the note", () => {
    renderTimeline();
    const trigger = container.querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const after = container.querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement;
    expect(after.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(
      after.getAttribute("aria-controls")!,
    )!;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Kitchen faucet leaking steadily");
  });
});
