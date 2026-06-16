// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCaseloadActivity } from "../../app/caseload/_lib/useCaseloadActivity";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ACTIVITY_BODY = {
  window: { from: "2026-05-16", to: "2026-08-15" },
  dataIssues: [],
  items: [
    {
      id: "p1:cn-1",
      participantId: "p1",
      participantName: "Casey Rivera",
      ymd: "2026-06-20",
      kind: "visit",
      status: "scheduled",
      label: "Stability Meeting",
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
let lastResult: { events: ReadonlyArray<unknown>; state: string };

function Probe({ enabled }: { readonly enabled: boolean }) {
  lastResult = useCaseloadActivity(enabled);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useCaseloadActivity", () => {
  it("does not fetch when disabled", async () => {
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    await act(async () => {
      root.render(<Probe enabled={false} />);
    });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lastResult.state).toBe("idle");
  });

  it("fetches once when enabled and maps the events", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify(ACTIVITY_BODY), { status: 200 }),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    await act(async () => {
      root.render(<Probe enabled={true} />);
    });
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/api/v1/caseload/activity");
    expect(lastResult.state).toBe("ready");
    expect(lastResult.events).toHaveLength(1);
    expect(lastResult.events[0]).toMatchObject({
      kind: "visit",
      title: "Stability Meeting",
      detail: "Scheduled",
      participantId: "p1",
    });
  });

  it("sets error state and keeps events empty on a failed fetch", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response("nope", { status: 500 }),
    );
    await act(async () => {
      root.render(<Probe enabled={true} />);
    });
    await flush();
    expect(lastResult.state).toBe("error");
    expect(lastResult.events).toEqual([]);
  });
});
