"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CaseloadFactor,
  CaseloadTriggeredInvariant,
} from "@anthos/api";

import { FactorBreakdownPanel } from "../../../_components/participant/FactorBreakdownPanel";

interface Props {
  readonly factors: ReadonlyArray<CaseloadFactor>;
  readonly triggeredInvariants: ReadonlyArray<CaseloadTriggeredInvariant>;
  readonly label?: string;
}

// F-07 priority "See full factor breakdown →" affordance. Lifts the
// FactorBreakdownPanel out of the inline PriorityCard column (now removed)
// and into a right-side drawer triggered from the PriorityStrip. Pure-visual
// refactor: the panel renders the same table BR-12 / AC-12 already require.
//
// Hand-rolled rather than reaching for @radix-ui/react-dialog so we don't add
// a runtime dep for what amounts to: open/close state + escape key + click
// outside + body scroll lock. Focus management is rudimentary (focuses the
// close button on open); good enough for an internal tool, swap to Radix
// only if the matrix grows (multiple drawers, nested modals, etc.).
export function FactorBreakdownDrawer({
  factors,
  triggeredInvariants,
  label = "See full factor breakdown",
}: Props) {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus to the close button so screen-reader users land inside the
    // dialog and Esc / Tab work naturally. Using a ref + effect rather than
    // `autoFocus` per jsx-a11y/no-autofocus — the prop is fine for dialogs
    // but the rule fires unconditionally; an effect-driven focus matches the
    // rule's intent (no surprise focus on initial page render).
    closeButtonRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {label} <span aria-hidden="true">→</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="factor-breakdown-drawer-heading"
          className="fixed inset-0 z-50"
        >
          <button
            type="button"
            aria-label="Close factor breakdown"
            onClick={close}
            className="absolute inset-0 bg-black/40"
            tabIndex={-1}
          />
          <aside className="absolute inset-y-0 right-0 flex w-full max-w-[640px] flex-col bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2
                id="factor-breakdown-drawer-heading"
                className="text-base font-semibold"
              >
                Full factor breakdown
              </h2>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={close}
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <FactorBreakdownPanel
                factors={factors}
                triggeredInvariants={triggeredInvariants}
              />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
