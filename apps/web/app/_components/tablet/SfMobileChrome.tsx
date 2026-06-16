import type { ReactNode } from "react";

// Demo-only fake Salesforce Mobile chrome. Rendered by `LandingSwitch` only
// when `?demo=sf` is present in the URL. Pure cosmetic decoration for
// stakeholder demos so the tablet view reads as "this is what specialists see
// when they tap the Aftercare tab inside SF Mobile."
//
// In production the standalone PWA mode has no SF chrome — this entire
// component is unmounted. See plan §"How specialists access this in
// production" for why.

interface Props {
  readonly children: ReactNode;
}

export function SfMobileChrome({ children }: Props) {
  return (
    <div className="min-h-screen bg-[#f3f2f2]">
      <div className="flex items-center justify-between bg-[#032d60] px-4 py-2.5 text-xs text-white">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true">☰</span>
          <span className="font-semibold">Salesforce</span>
        </div>
        <span className="text-white/70">Spotify</span>
      </div>
      <div className="flex items-center gap-2.5 border-b border-zinc-200 bg-white px-4 py-2.5 text-[13px]">
        <button
          type="button"
          className="text-[#0070d2]"
          aria-label="Back to Salesforce"
        >
          ‹
        </button>
        <span className="flex-1 truncate font-bold text-[#1d2a4a]">
          Stability Visit · 2:00 PM
        </span>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
          Just ended
        </span>
      </div>
      {children}
    </div>
  );
}
