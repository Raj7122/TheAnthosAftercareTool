// @vitest-environment happy-dom

// P3B-06 — the tablet Quick Log sheet: one Notes field + a two-route segmented
// toggle (Case Note | Repair) + one Send. These tests lock the default route,
// note-preservation across the toggle, the per-route submit payloads (Case Note
// sends the server defaults; Repair sends just the note), and the per-route
// required-note guard.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickLogSheet } from "../../app/_components/tablet/QuickLogSheet";
import type { CreateCaseNoteInput } from "../../app/_components/case-notes/types";
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

function setValue(el: HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderSheet(opts?: {
  onSubmitCaseNote?: (input: CreateCaseNoteInput) => Promise<null>;
  onSubmitRepair?: (input: CreateRepairInput) => Promise<null>;
  displayName?: string | null;
}) {
  act(() => {
    root.render(
      <QuickLogSheet
        participantId="a015g00000ABCDxQAO"
        displayName={opts?.displayName ?? null}
        onCancel={() => {}}
        onSubmitCaseNote={opts?.onSubmitCaseNote ?? (() => Promise.resolve(null))}
        onSubmitRepair={opts?.onSubmitRepair ?? (() => Promise.resolve(null))}
      />,
    );
  });
}

function routeButtons(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll('[role="radio"]'),
  ) as HTMLButtonElement[];
}

describe("QuickLogSheet", () => {
  it("renders Notes + the two-route toggle, default Case Note, no picklists", () => {
    renderSheet();
    expect(container.textContent).toContain("Log Note");
    expect(container.querySelectorAll("select")).toHaveLength(0);
    const [caseNote, repair] = routeButtons();
    expect(caseNote?.textContent).toBe("Case Note");
    expect(repair?.textContent).toBe("Repair");
    expect(caseNote?.getAttribute("aria-checked")).toBe("true");
    expect(repair?.getAttribute("aria-checked")).toBe("false");
  });

  it("titles the sheet with the participant name, not the SF id", () => {
    renderSheet({ displayName: "Marie Alcis" });
    expect(container.textContent).toContain("Participant Marie Alcis");
    expect(container.textContent).not.toContain("a015g00000ABCDxQAO");
  });

  it("keeps the typed note when switching route", () => {
    renderSheet();
    const textarea = container.querySelector("textarea")!;
    act(() => setValue(textarea, "broken radiator"));
    const [, repair] = routeButtons();
    act(() => repair!.click());
    expect(repair!.getAttribute("aria-checked")).toBe("true");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "broken radiator",
    );
  });

  it("submits the Case Note route with the server defaults", async () => {
    const onSubmitCaseNote = vi.fn(() => Promise.resolve(null));
    renderSheet({ onSubmitCaseNote });
    const textarea = container.querySelector("textarea")!;
    const form = container.querySelector("form")!;
    await act(async () => setValue(textarea, "Quarterly stability check"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmitCaseNote).toHaveBeenCalledTimes(1);
    expect(onSubmitCaseNote).toHaveBeenCalledWith({
      note: "Quarterly stability check",
      contactType: "Phone",
      type: "Check In",
      status: "Completed",
    });
  });

  it("submits the Repair route with just the note", async () => {
    const onSubmitCaseNote = vi.fn(() => Promise.resolve(null));
    const onSubmitRepair = vi.fn(() => Promise.resolve(null));
    renderSheet({ onSubmitCaseNote, onSubmitRepair });
    const textarea = container.querySelector("textarea")!;
    const [, repair] = routeButtons();
    const form = container.querySelector("form")!;
    await act(async () => {
      setValue(textarea, "leaky faucet");
      repair!.click();
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmitRepair).toHaveBeenCalledTimes(1);
    expect(onSubmitRepair).toHaveBeenCalledWith({ note: "leaky faucet" });
    expect(onSubmitCaseNote).not.toHaveBeenCalled();
  });

  it("blocks submit with the route-appropriate error when the note is empty", async () => {
    const onSubmitCaseNote = vi.fn(() => Promise.resolve(null));
    const onSubmitRepair = vi.fn(() => Promise.resolve(null));
    renderSheet({ onSubmitCaseNote, onSubmitRepair });
    const form = container.querySelector("form")!;

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmitCaseNote).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A case note is required.");

    const [, repair] = routeButtons();
    await act(async () => repair!.click());
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmitRepair).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A repair note is required.");
  });
});
