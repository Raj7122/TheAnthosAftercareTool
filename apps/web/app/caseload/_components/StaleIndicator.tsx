"use client";

import { useEffect, useState } from "react";

import {
  deriveStaleState,
  formatAsOfTime,
  STALE_DISPLAY_THRESHOLD_MS,
} from "../_lib/stale";

interface Props {
  readonly cacheAgeSeconds: number;
  readonly fetchedAt: Date;
}

// "Live · HH:MM ET" / "Stale · HH:MM ET" pill with a status dot (emerald when
// fresh, amber once the SPA has shown cache-served data past the threshold). The
// ticket explicitly asks for non-alarming styling — the dot, not red text.
//
// A 60s tick refreshes the stale derivation without a server round trip; the
// indicator's appearance can change on the tick even though the underlying
// data hasn't.
export function StaleIndicator({ cacheAgeSeconds, fetchedAt }: Props) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const state = deriveStaleState({ cacheAgeSeconds, fetchedAt, now });

  // Pill with a leading status dot — amber when serving stale cache, emerald
  // when fresh. Non-alarming per the F-16 ticket: the dot, not red text,
  // carries the staleness signal.
  return (
    <div
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500"
      data-testid="stale-indicator"
      {...(state.isStale
        ? {
            "aria-label": `Showing cached data older than ${Math.floor(
              STALE_DISPLAY_THRESHOLD_MS / 60_000,
            )} minutes`,
          }
        : {})}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          state.isStale ? "bg-amber-500" : "bg-emerald-500"
        }`}
      />
      <span>
        {state.isStale ? "Stale" : "Live"} · {formatAsOfTime(state.asOf)}
      </span>
    </div>
  );
}
