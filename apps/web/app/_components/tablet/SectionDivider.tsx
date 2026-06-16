// Horizontal divider with an overlapping uppercase label, e.g.
// "PENDING SYNC" or "OR PICK ANOTHER PARTICIPANT". The label sits on a
// solid background to break the rule line cleanly.
//
// `text-zinc-500` is the WCAG-AA-passing port of the mockup's
// `#9ca3af` (gray-400) label color, which fails AA at 11px against the
// `#fafbfc` page background (2.47 vs. required 4.5 contrast ratio).
// PR #230 a11y test catches it; zinc-500 (#71717a) clears AA at ~4.6.

interface Props {
  readonly label: string;
}

export function SectionDivider({ label }: Props) {
  return (
    <div className="relative mx-4 mb-3 mt-5 border-t border-zinc-200">
      <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 bg-[#fafbfc] px-3 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
        {label}
      </span>
    </div>
  );
}
