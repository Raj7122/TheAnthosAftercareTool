"use client";

import { useEffect, useId, useRef } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";

// Test fixture for `ActionSheetShell`. Originally a P3B-02 demo affordance on
// the tablet landing; PR #230 moved the landing to an inline JustCompleted-
// VisitCard, so this component no longer mounts from `/`. The two E2E specs
// that exercise `ActionSheetShell` invariants (`tablet-action-sheets.e2e.ts`,
// `a11y-demo-path.e2e.ts`) reach it via the dedicated `/demo/action-sheet`
// route — same surface they used to reach via the landing CTA, just with no
// shared mount.

interface Props {
  readonly onClose: () => void;
}

export function SchedulingSheetPlaceholder({ onClose }: Props) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <ActionSheetShell titleId={titleId} onCancel={onClose}>
      <h2 id={titleId} className="text-lg font-semibold">
        Scheduling sheet — P3A-05
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The scheduling-sheet log path opens here once P3A-05 ships.
      </p>
      <div className="mt-6 flex justify-end">
        <Button
          ref={closeButtonRef}
          type="button"
          variant="outline"
          onClick={onClose}
          className="h-14 w-full px-6 text-base"
        >
          Close
        </Button>
      </div>
    </ActionSheetShell>
  );
}
