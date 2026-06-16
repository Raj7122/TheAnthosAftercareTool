"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { useDeviceVariant } from "@/lib/device";
import { useFocusTrap } from "@/lib/use-focus-trap";

// P3B-04 — shared action-sheet chrome (F-13).
//
// The three action sheets that exist today (LogCallSheet, CreateBarrierSheet,
// CloseBarrierConfirm) used to duplicate the same dialog scaffolding inline:
// role="dialog" + aria-modal, backdrop + container shape, focus trap,
// Escape-to-close. They also relied on Tailwind's `sm:` breakpoint to flip
// between bottom-drawer and centered-modal, which made the tablet path
// viewport-accidental — exactly what P3B-01's "intentional, not accidental"
// rule forbids.
//
// This shell consolidates the scaffolding and consumes `useDeviceVariant()`
// directly. The tablet branch locks to a true bottom drawer (no `sm:`
// flip, no `max-w-md` cap), gets generous bottom padding so the primary CTA
// clears the home-bar area, and uses `rounded-t-xl` to match the
// caseload-card visual language. The laptop branch preserves today's
// behavior verbatim so the desktop iframe path doesn't regress.
//
// Heading, form body, and footer buttons stay in each sheet so
// variant-specific primary-CTA sizing is co-located with the labels and
// validation state it depends on; the shell owns layout chrome only, not
// copy or mutation semantics.
//
// Future sheets shipping via P1H-11 (SMS / email compose) and P3A-05
// (scheduling sheet) inherit the tablet idiom by adopting this shell.

interface Props {
  readonly titleId: string;
  readonly onCancel: () => void;
  // While `submitting === true` the parent sheet wants Escape and the
  // backdrop to NO-OP so an in-flight mutation can't be abandoned by an
  // errant tap.
  readonly dismissDisabled?: boolean;
  readonly children: ReactNode;
}

export function ActionSheetShell({
  titleId,
  onCancel,
  dismissDisabled = false,
  children,
}: Props) {
  const variant = useDeviceVariant();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape" && !dismissDisabled) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, dismissDisabled]);

  // Body scroll-lock — without this the page behind the sheet scrolls when
  // the iPad-portrait keyboard appears for dictation (F-19 / BR-91), which
  // visually re-flows the form mid-input.
  //
  // Depth-counted so nested/stacked shells don't race the cleanup: the
  // first mount captures the prior overflow and applies `hidden`; the
  // last unmount restores the captured value. Without the counter, a
  // second shell mounting while the first is open would capture
  // `"hidden"` as its "previous" value and never restore the original on
  // close.
  useEffect(() => {
    const body = document.body;
    const depth =
      Number(body.dataset.actionSheetLockDepth ?? "0") + 1;
    body.dataset.actionSheetLockDepth = String(depth);
    if (depth === 1) {
      body.dataset.actionSheetPriorOverflow = body.style.overflow;
      body.style.overflow = "hidden";
    }
    return () => {
      const next = Number(body.dataset.actionSheetLockDepth ?? "1") - 1;
      if (next <= 0) {
        body.style.overflow = body.dataset.actionSheetPriorOverflow ?? "";
        delete body.dataset.actionSheetLockDepth;
        delete body.dataset.actionSheetPriorOverflow;
      } else {
        body.dataset.actionSheetLockDepth = String(next);
      }
    };
  }, []);

  const outerClass =
    variant === "tablet"
      ? "fixed inset-0 z-50 flex items-end justify-center bg-foreground/40"
      : "fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 sm:items-center";

  const innerClass =
    variant === "tablet"
      ? "w-full rounded-t-xl border bg-background p-6 pb-8 shadow-lg"
      : "w-full max-w-md rounded-t-lg border bg-background p-6 shadow-lg sm:rounded-lg";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={outerClass}
      data-variant={variant}
      data-testid="action-sheet-shell"
    >
      <div
        ref={dialogRef}
        className={innerClass}
        data-testid="action-sheet-shell-content"
      >
        {children}
      </div>
    </div>
  );
}
