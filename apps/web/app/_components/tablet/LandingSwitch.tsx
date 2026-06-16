"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type { CaseloadItem } from "@anthos/api";

import { resolveCurrentDeviceVariant, useDeviceVariant } from "@/lib/device";

import { SfMobileChrome } from "./SfMobileChrome";
import { TabletLanding } from "./TabletLanding";

// P3B-02: variant router at `/`. useDeviceVariant() SSR-defaults to 'laptop'
// (P3B-01 hook contract), so tablet specialists may see one frame of the
// laptop loading state before hydration flips.
//
// Laptop entry: `/` is the bare origin the Salesforce-Console iframe loads,
// but the laptop caseload surface lives at `/caseload`. So the laptop branch
// client-redirects there — `/caseload` already owns the F-01 auth gate
// (401 → OAuth) and renders the full F-02/F-04 SPA, which `/` deliberately
// does not (it stays a 200-OK auth-tolerant landing for the Playwright
// webServer probe). The redirect MUST read the *real* variant synchronously
// (`resolveCurrentDeviceVariant`) rather than the hook's 'laptop' default,
// or a tablet's first paint would fire it and mis-route the field device.
//
// Demo affordance: `?demo=sf` wraps the tablet view in the fake Salesforce
// Mobile chrome so stakeholder walkthroughs match the mockup. Production
// (standalone PWA mode) never sets the query param — the chrome is unmounted
// and the tablet view fills the entire viewport.

interface Props {
  readonly initialCaseloadItems: ReadonlyArray<CaseloadItem>;
  readonly caseloadCount: number;
  readonly specialistName: string | null;
  readonly specialistId: string | null;
  readonly canLogCaseNotes: boolean;
  readonly isAuthenticated: boolean;
}

export function LandingSwitch({
  initialCaseloadItems,
  caseloadCount,
  specialistName,
  specialistId,
  canLogCaseNotes,
  isAuthenticated,
}: Props) {
  const router = useRouter();
  const variant = useDeviceVariant();
  const searchParams = useSearchParams();
  const demoChrome = searchParams?.get("demo") === "sf";

  // Laptop → hand off to the caseload SPA. `replace` (not `push`) so Back
  // doesn't return to this transient landing.
  useEffect(() => {
    if (resolveCurrentDeviceVariant() === "laptop") {
      router.replace("/caseload");
    }
  }, [router]);

  // Tablet + no live session + not the demo walkthrough → bounce to OAuth
  // login. The server keeps `/` at 200 OK (Playwright webServer probe + the
  // auth-tolerant landing); this redirect is purely client-side, after
  // hydration. Read the *real* variant synchronously (not the hook's 'laptop'
  // SSR default) so it never fires on a tablet's first laptop-default frame —
  // mirrors the laptop effect above. `window.location.assign` (full
  // navigation), NOT router.replace: the login route 302s to an external
  // Salesforce origin, which Next client routing can't follow. `?demo=sf`
  // stays exempt so the stakeholder fixtures walkthrough still renders. No
  // loop: after OAuth the cookie is set, `/me` returns 200, `isAuthenticated`
  // is true and this short-circuits.
  useEffect(() => {
    if (demoChrome) return;
    if (isAuthenticated) return;
    if (resolveCurrentDeviceVariant() !== "tablet") return;
    const returnTo = encodeURIComponent("/?view=tablet");
    window.location.assign(`/api/v1/auth/login?returnTo=${returnTo}`);
  }, [demoChrome, isAuthenticated]);

  if (variant === "tablet") {
    const tablet = (
      <TabletLanding
        initialCaseloadItems={initialCaseloadItems}
        caseloadCount={caseloadCount}
        specialistName={specialistName}
        specialistId={specialistId}
        canLogCaseNotes={canLogCaseNotes}
      />
    );
    return demoChrome ? <SfMobileChrome>{tablet}</SfMobileChrome> : tablet;
  }

  // Laptop branch — a brief landing while the `/caseload` redirect above
  // resolves. Also the universal first paint (the hook defaults to 'laptop')
  // that tablets show for one frame before flipping to `TabletLanding`.
  return (
    <main className="grid min-h-screen place-items-center p-8">
      <p role="status" className="text-sm text-muted-foreground">
        Loading your caseload…
      </p>
    </main>
  );
}
