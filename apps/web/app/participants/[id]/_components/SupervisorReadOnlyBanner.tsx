// F-07 AC-29 — supervisor read-only banner. Renders ABOVE the quick-actions
// bar so the single "informational" surface explains why all four buttons are
// disabled, instead of forcing four individual tooltips. The buttons still
// carry their own `title` for accessibility parity.
export function SupervisorReadOnlyBanner() {
  return (
    <div
      role="note"
      className="rounded-md border border-muted bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
    >
      Read-only access for supervisors &mdash; quick actions are disabled.
    </div>
  );
}
