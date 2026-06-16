// @vitest-environment happy-dom

// Landing fix — `/` variant router. The laptop branch hands off to the
// `/caseload` SPA (the bare origin the Salesforce-Console iframe loads is a
// device-variant router, not the laptop caseload surface); the tablet branch
// renders the F-13 field home in place. The device hook + `next/navigation`
// router are mocked so this is a focused decision test — the variant signal
// resolution itself is covered by `device.test.ts` / `device-window.test.ts`.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const hoisted = vi.hoisted(() => ({
  replaceSpy: vi.fn(),
  assignSpy: vi.fn(),
  variant: "laptop" as "laptop" | "tablet",
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: hoisted.replaceSpy,
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(hoisted.search),
}));

vi.mock("@/lib/device", () => ({
  resolveCurrentDeviceVariant: () => hoisted.variant,
  useDeviceVariant: () => hoisted.variant,
}));

// Stub the children so the test doesn't drag in TabletLanding's offline hooks
// or SfMobileChrome's assets — only the branch selection matters here.
vi.mock("../../app/_components/tablet/TabletLanding", () => ({
  TabletLanding: () => <div data-testid="tablet-landing-mock" />,
}));
vi.mock("../../app/_components/tablet/SfMobileChrome", () => ({
  SfMobileChrome: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sf-mobile-chrome">{children}</div>
  ),
}));

// Imported AFTER the mocks are registered.
const { LandingSwitch } = await import(
  "../../app/_components/tablet/LandingSwitch"
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  hoisted.replaceSpy.mockClear();
  hoisted.assignSpy.mockClear();
  hoisted.variant = "laptop";
  hoisted.search = "";
  // The unauth-tablet branch calls `window.location.assign` (full navigation
  // to the OAuth route). Stub it so happy-dom doesn't attempt a real nav.
  vi.spyOn(window.location, "assign").mockImplementation(hoisted.assignSpy);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

// `isAuthenticated` defaults to true so the existing decision tests assert the
// variant branch without tripping the unauth → OAuth redirect effect.
function render(isAuthenticated = true): void {
  act(() => {
    root.render(
      <LandingSwitch
        initialCaseloadItems={[]}
        caseloadCount={0}
        specialistName={null}
        specialistId={null}
        canLogCaseNotes={false}
        isAuthenticated={isAuthenticated}
      />,
    );
  });
}

describe("LandingSwitch", () => {
  it("redirects the laptop variant to /caseload and renders no tablet surface", () => {
    hoisted.variant = "laptop";
    render();
    expect(hoisted.replaceSpy).toHaveBeenCalledWith("/caseload");
    expect(
      container.querySelector('[data-testid="tablet-landing-mock"]'),
    ).toBeNull();
  });

  it("renders TabletLanding and does NOT redirect on the authenticated tablet variant", () => {
    hoisted.variant = "tablet";
    render(true);
    expect(hoisted.replaceSpy).not.toHaveBeenCalled();
    expect(hoisted.assignSpy).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="tablet-landing-mock"]'),
    ).not.toBeNull();
  });

  it("wraps the tablet view in the SF mobile chrome on ?demo=sf", () => {
    hoisted.variant = "tablet";
    hoisted.search = "demo=sf";
    render(true);
    expect(hoisted.replaceSpy).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="sf-mobile-chrome"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tablet-landing-mock"]'),
    ).not.toBeNull();
  });

  it("bounces an unauthenticated tablet to the OAuth login with a tablet returnTo", () => {
    hoisted.variant = "tablet";
    render(false);
    expect(hoisted.assignSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.assignSpy).toHaveBeenCalledWith(
      "/api/v1/auth/login?returnTo=%2F%3Fview%3Dtablet",
    );
    expect(hoisted.replaceSpy).not.toHaveBeenCalled();
  });

  it("does NOT bounce an unauthenticated tablet in the ?demo=sf walkthrough", () => {
    hoisted.variant = "tablet";
    hoisted.search = "demo=sf";
    render(false);
    expect(hoisted.assignSpy).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="sf-mobile-chrome"]'),
    ).not.toBeNull();
  });

  it("does NOT bounce an unauthenticated laptop to login (laptop hands off to /caseload)", () => {
    hoisted.variant = "laptop";
    render(false);
    expect(hoisted.assignSpy).not.toHaveBeenCalled();
    expect(hoisted.replaceSpy).toHaveBeenCalledWith("/caseload");
  });
});
