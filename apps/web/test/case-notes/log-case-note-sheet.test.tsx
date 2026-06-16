// @vitest-environment happy-dom

// The Log Case Note sheet: a required note + Contact type / Type / Status
// dropdowns that route to IDW_Case_Note__c. These tests lock the field routing
// (dropdown values reach onSubmit) and the required-note guard.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogCaseNoteSheet } from "../../app/_components/case-notes/LogCaseNoteSheet";
import type { CreateCaseNoteInput } from "../../app/_components/case-notes/types";

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

function setValue(
  el: HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventType: "input" | "change",
) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event(eventType, { bubbles: true }));
}

function renderSheet(
  onSubmit: (input: CreateCaseNoteInput) => Promise<null>,
  displayName: string | null = null,
) {
  act(() => {
    root.render(
      <LogCaseNoteSheet
        participantId="a015g00000ABCDxQAO"
        displayName={displayName}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
  });
}

describe("LogCaseNoteSheet", () => {
  it("renders the note field + three picklists with the defaults selected", () => {
    renderSheet(() => Promise.resolve(null));
    expect(container.textContent).toContain("Log Case Note");
    const selects = container.querySelectorAll("select");
    expect(selects).toHaveLength(3);
    // Defaults: Phone / Check In / Completed.
    expect((selects[0] as HTMLSelectElement).value).toBe("Phone");
    expect((selects[1] as HTMLSelectElement).value).toBe("Check In");
    expect((selects[2] as HTMLSelectElement).value).toBe("Completed");
  });

  it("titles the sheet with the participant name, not the SF id", () => {
    renderSheet(() => Promise.resolve(null), "Marie Alcis");
    expect(container.textContent).toContain("Participant Marie Alcis");
    expect(container.textContent).not.toContain("a015g00000ABCDxQAO");
  });

  it("falls back to the SF id when no name is resolved", () => {
    renderSheet(() => Promise.resolve(null), null);
    expect(container.textContent).toContain("Participant a015g00000ABCDxQAO");
  });

  it("submits the note routed with the chosen picklist values", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(null));
    renderSheet(onSubmit);
    const textarea = container.querySelector("textarea")!;
    const [contact, type, status] = Array.from(
      container.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    const form = container.querySelector("form")!;

    await act(async () => {
      setValue(textarea, "Quarterly stability check", "input");
      setValue(contact!, "In Person", "change");
      setValue(type!, "Stability Meeting", "change");
      setValue(status!, "Attempted", "change");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      note: "Quarterly stability check",
      contactType: "In Person",
      type: "Stability Meeting",
      status: "Attempted",
    });
  });

  it("blocks submit and surfaces an error when the note is empty", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(null));
    renderSheet(onSubmit);
    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A case note is required.");
  });
});
