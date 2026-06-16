"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { SchedulingSheetPlaceholder } from "../../_components/tablet/SchedulingSheetPlaceholder";

// Test-fixture route. Hosts the "Log this visit?" CTA + ActionSheetShell
// trigger that two E2E specs use to exercise the shell primitive without
// pulling in the auth/caseload-cache fixture chain:
//   - `tablet-action-sheets.e2e.ts` — shell variant + bottom-pin + size
//   - `a11y-demo-path.e2e.ts` — axe scan on the shell while open
//
// Previously these specs reached the placeholder via the tablet landing
// itself (PR #230 replaced the landing's one-button stub with the inline
// JustCompletedVisitCard surface). The placeholder lives here now so the
// test invariants are preserved without re-introducing the bottom-sheet
// pattern in the production landing.

export default function ActionSheetDemoPage() {
  const [open, setOpen] = useState(false);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 px-6">
      <h1 className="text-center text-2xl font-semibold">
        ActionSheetShell demo
      </h1>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        className="h-14 w-full max-w-md px-6 text-lg"
      >
        Log this visit?
      </Button>
      {open && <SchedulingSheetPlaceholder onClose={() => setOpen(false)} />}
    </main>
  );
}
