// P3C-02 — Session-expiry wipe for the drafts store (TR-OFFLINE-9 / ARC-30).
//
// Mirrors `wipeOutbox()` in `../wipe-on-expiry.ts` lines 22–33: clear() over
// the live `idb-keyval` connection (NOT `deleteDatabase`) because idb-keyval
// does not expose a close handle on its internal connection, and a blind
// `deleteDatabase` would block on the in-process connection or leak a
// pending request that blocks the next `open()`. The functional guarantee
// TR-OFFLINE-9 demands is "no queued draft data remains after session
// expiry", which `clear()` satisfies.
//
// We also reset the in-process Zustand slice so any open sheet that's
// currently subscribed to the store re-reads empty state on the next render.
// Without that, the IDB rows would be gone but the React tree would still
// hold stale draft text in memory until the next remount.

import { clear } from "idb-keyval";

import { draftsKvStore } from "./kv";
import { useDraftStore } from "./store";

export async function wipeDrafts(): Promise<void> {
  await clear(draftsKvStore());
  useDraftStore.setState({
    activeSpecialistId: null,
    logCall: {},
    createBarrier: {},
    smsCompose: {},
    emailCompose: {},
    scheduleVisit: {},
  });
}
