// @vitest-environment happy-dom

// P3C-13 — `useOutbox()` view model: reads persisted rows, re-reads on Outbox
// change notifications, and joins the transient `replay.ts` status so a
// just-confirmed row flashes "synced" (then drops) while the badge `count`
// stays honest (persisted-only — a synced flash does NOT inflate it).

import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAll,
  enqueue,
  remove,
  resetOutboxStoreForTests,
} from "../../app/_lib/offline/outbox";
import {
  replayOutbox,
  resetReplayStateForTests,
} from "../../app/_lib/offline/replay";
import { useOutbox } from "../../app/_lib/offline/use-outbox";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

let container: HTMLDivElement;
let root: Root;

function Harness() {
  const { items, count } = useOutbox();
  return (
    <div
      data-testid="harness"
      data-count={count}
      data-ids={items.map((i) => i.id).join(",")}
      data-statuses={items.map((i) => i.uiStatus).join(",")}
    />
  );
}

function read(): { count: string | null; ids: string | null; statuses: string | null } {
  const el = container.querySelector('[data-testid="harness"]');
  return {
    count: el?.getAttribute("data-count") ?? null,
    ids: el?.getAttribute("data-ids") ?? null,
    statuses: el?.getAttribute("data-statuses") ?? null,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  await clearAll();
  resetReplayStateForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
  await flush();
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await clearAll();
  resetOutboxStoreForTests();
  resetReplayStateForTests();
});

describe("useOutbox", () => {
  it("reflects an enqueued row as pending_sync and counts it", async () => {
    await act(async () => {
      await enqueue({
        endpoint: "/api/v1/x/1",
        method: "POST",
        body: null,
        idempotencyKey: "k-1",
      });
    });
    await flush();

    expect(read().count).toBe("1");
    expect(read().ids).toBe("k-1");
    expect(read().statuses).toBe("pending_sync");
  });

  it("re-reads and drops the row on remove()", async () => {
    await act(async () => {
      await enqueue({
        endpoint: "/api/v1/x/1",
        method: "POST",
        body: null,
        idempotencyKey: "k-1",
      });
    });
    await flush();
    await act(async () => {
      await remove("k-1");
    });
    await flush();

    expect(read().count).toBe("0");
    expect(read().ids).toBe("");
  });

  it("flashes synced after a confirmed replay, with count back to 0", async () => {
    await act(async () => {
      await enqueue({
        endpoint: "/api/v1/x/1",
        method: "POST",
        body: null,
        idempotencyKey: "k-1",
      });
    });
    await flush();

    // Capture the flash-clear callback so the "synced" state is observable.
    let clearFlash: () => void = () => {};
    await act(async () => {
      await replayOutbox({
        fetchImpl: async () => okResponse(),
        flashMs: 1000,
        schedule: (cb) => {
          clearFlash = cb;
        },
      });
    });
    await flush();

    // Row removed from IDB (count 0) but flashed "synced" from the snapshot.
    expect(read().count).toBe("0");
    expect(read().statuses).toBe("synced");

    // Flash expires → row disappears entirely.
    await act(async () => {
      clearFlash();
    });
    await flush();
    expect(read().ids).toBe("");
    expect(read().statuses).toBe("");
  });
});
