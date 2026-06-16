// @vitest-environment happy-dom

// The Add Repair sheet: a single required note that always routes to the
// repair's Description field. These tests lock that the note reaches onSubmit
// (with no destination selector) and the required-note guard.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateRepairSheet } from "../../app/_components/repairs/CreateRepairSheet";
import type { CreateRepairInput } from "../../app/_components/repairs/types";

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

// React tracks controlled-input values via a hidden setter on the element
// prototype; calling it (then dispatching the event) is how you simulate typing
// without Testing Library.
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
  onSubmit: (input: CreateRepairInput) => Promise<null>,
  displayName: string | null = null,
) {
  act(() => {
    root.render(
      <CreateRepairSheet
        participantId="a015g00000ABCDxQAO"
        displayName={displayName}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
  });
}

describe("CreateRepairSheet", () => {
  it("renders the Add Repair title with no destination selector", () => {
    renderSheet(() => Promise.resolve(null));
    expect(container.textContent).toContain("Add Repair");
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("ATC Notes");
    expect(container.textContent).not.toContain("Save note to");
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

  it("submits the typed note", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(null));
    renderSheet(onSubmit);

    const textarea = container.querySelector("textarea")!;
    const form = container.querySelector("form")!;

    await act(async () => {
      setValue(textarea, "Cracked bathroom tile", "input");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ note: "Cracked bathroom tile" });
  });

  it("blocks submit and surfaces an error when the note is empty", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(null));
    renderSheet(onSubmit);
    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A repair note is required.");
  });
});
