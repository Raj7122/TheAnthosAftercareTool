// @vitest-environment happy-dom

// The participant-timeline case-note row is a disclosure: collapsed it shows
// "Case note logged at <date> · {type}" (never the note body); expanding reveals
// the note. Locks the note-hiding behavior.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecentContactsTimeline } from "../../app/participants/[id]/_components/RecentContactsTimeline";
import type { OptimisticCaseNote } from "../../app/_components/case-notes/types";

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

const CASE_NOTE: OptimisticCaseNote = {
  caseNoteId: "a1dE2E0CASExQAO1",
  participantId: "a015g00000ABCDxQAO",
  participantName: "Marie Alcis",
  serviceDate: "2026-06-04",
  note: "Discussed rent arrears plan in detail",
  contactType: "Phone",
  type: "Check In",
  status: "Completed",
  loggedAt: "2026-06-04T15:30:00.000Z",
};

function renderTimeline() {
  act(() => {
    root.render(
      <RecentContactsTimeline recentContacts={[]} caseNotes={[CASE_NOTE]} />,
    );
  });
}

describe("RecentContactsTimeline — case-note disclosure row", () => {
  it("collapsed: shows 'Case note logged at <date>' and hides the note body", () => {
    renderTimeline();
    const trigger = container.querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Case note logged at");
    expect(trigger!.textContent).toContain("Check In");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(
      trigger!.getAttribute("aria-controls")!,
    )!;
    expect(panel.hidden).toBe(true);
    expect(trigger!.textContent).not.toContain("rent arrears plan");
  });

  it("expands on click to reveal the note", () => {
    renderTimeline();
    const trigger = container.querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const after = container.querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement;
    expect(after.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(
      after.getAttribute("aria-controls")!,
    )!;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Discussed rent arrears plan in detail");
  });
});
