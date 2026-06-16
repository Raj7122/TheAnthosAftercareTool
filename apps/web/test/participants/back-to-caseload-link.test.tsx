// @vitest-environment happy-dom

// BackToCaseloadLink — the "Back to caseload" affordance on `/participants/[id]`
// (detail view + error states). Its destination is variant-dependent: tablet
// returns to the `/` field landing, laptop to the `/caseload` SPA. The device
// hook is mocked so this is a focused href-by-variant test.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const hoisted = vi.hoisted(() => ({
  variant: "laptop" as "laptop" | "tablet",
}));

vi.mock("@/lib/device", () => ({
  useDeviceVariant: () => hoisted.variant,
}));

const { BackToCaseloadLink } = await import(
  "../../app/participants/[id]/_components/BackToCaseloadLink"
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  hoisted.variant = "laptop";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(): void {
  act(() => {
    root.render(
      <BackToCaseloadLink variant="outline" className="h-11">
        Back to caseload
      </BackToCaseloadLink>,
    );
  });
}

describe("BackToCaseloadLink", () => {
  it("links to /caseload on the laptop variant", () => {
    hoisted.variant = "laptop";
    render();
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("/caseload");
  });

  it("links to / (tablet landing) on the tablet variant", () => {
    hoisted.variant = "tablet";
    render();
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("/");
  });

  it("renders its children and forwarded className", () => {
    render();
    const anchor = container.querySelector("a");
    expect(anchor?.textContent).toContain("Back to caseload");
    expect(anchor?.className).toContain("h-11");
  });
});
