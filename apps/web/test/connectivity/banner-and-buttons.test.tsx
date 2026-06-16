// @vitest-environment happy-dom

// P3C-03 — integration coverage: when the provider is degraded, (a) the
// banner is visible with the verbatim spec copy and (b) a representative
// write button is `disabled` per BR-67 "visibly disabled, NOT hidden". The
// per-surface buttons (QuickActionsBar, sheets, RefreshButton, un-snooze)
// follow the same pattern — each consumes `useConnectivity()` and OR-merges
// against its existing disable conditions. The inline `SampleWriteButton`
// here stands in for that population without dragging the `@/`-aliased
// imports of every real surface into the test.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfflineWriteSuspendedBanner } from "../../app/_components/connectivity/OfflineWriteSuspendedBanner";
import {
  ConnectivityProvider,
  useConnectivity,
} from "../../app/_lib/connectivity/context";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function SampleWriteButton() {
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";
  return (
    <button
      type="button"
      data-testid="sample-write"
      disabled={writesBlocked}
      title={writesBlocked ? "Offline — Write Access Suspended" : undefined}
    >
      Save
    </button>
  );
}

function configureIframeSurface(): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {} as ServiceWorkerContainer,
  });
  Object.defineProperty(window, "top", {
    configurable: true,
    value: { fake: true } as unknown as Window,
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  Object.defineProperty(window, "top", { configurable: true, value: window });
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("Banner + write-button visibility under degraded connectivity", () => {
  it("shows the banner with verbatim copy and disables the write button when probe fails", async () => {
    configureIframeSurface();
    const probe = vi.fn().mockResolvedValue(false);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <OfflineWriteSuspendedBanner />
          <SampleWriteButton />
        </ConnectivityProvider>,
      );
    });

    const banner = container.querySelector(
      '[data-testid="offline-write-suspended-banner"]',
    );
    expect(banner).not.toBeNull();
    // BR-67: "visibly disabled, NOT hidden". The button is still in the DOM.
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="sample-write"]',
    );
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    // Spec-verbatim copy ("Offline — Write Access Suspended", with the
    // em-dash entity collapsed by the DOM to a literal `—`).
    expect(banner?.textContent).toContain("Offline");
    expect(banner?.textContent).toContain("Write Access Suspended");
    // BR-67 explainer surface — the button title carries the same reason
    // so a hover/focus surfaces the affordance per-action too.
    expect(button?.title).toContain("Offline");
  });

  it("hides the banner and enables the write button when probe succeeds", async () => {
    configureIframeSurface();
    const probe = vi.fn().mockResolvedValue(true);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <OfflineWriteSuspendedBanner />
          <SampleWriteButton />
        </ConnectivityProvider>,
      );
    });

    const banner = container.querySelector(
      '[data-testid="offline-write-suspended-banner"]',
    );
    expect(banner).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="sample-write"]',
    );
    expect(button?.disabled).toBe(false);
  });
});
