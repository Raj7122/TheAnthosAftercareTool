// Tool's own header (separate from the demo-only `SfMobileChrome` wrapper).
// Navy bar with the yellow "A" brand mark + "ANTHOS Aftercare" title +
// pending-count badge top-right.
//
// `pendingCount` is supplied by the parent so this stays a pure presentational
// component — the demo populates it from the fixture queue length; production
// will populate from `useQueuePending().count`.
//
// `specialistName` is the signed-in specialist's display name (from /me). It
// labels whose caseload is on screen; null when no live session resolves.

interface Props {
  readonly pendingCount: number;
  readonly specialistName: string | null;
}

export function TabletHeader({ pendingCount, specialistName }: Props) {
  return (
    <header className="flex items-center justify-between bg-tabletPrimary px-4 py-3.5 text-white">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-md bg-tabletAccent text-tabletPrimary text-sm font-bold"
        >
          A
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold tracking-wide">
            ANTHOS Aftercare
          </span>
          {specialistName !== null && (
            <span
              className="text-xs font-medium text-white/70"
              data-testid="tablet-header-specialist"
            >
              {specialistName} &middot; Aftercare Specialist
            </span>
          )}
        </div>
      </div>
      {pendingCount > 0 && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-tabletPending px-3 py-1.5 text-xs font-semibold text-amber-900"
          data-testid="tablet-header-pending-badge"
        >
          <span aria-hidden="true">⚠</span>
          {pendingCount} pending
        </span>
      )}
    </header>
  );
}
