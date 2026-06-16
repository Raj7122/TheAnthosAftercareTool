"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

// The `/participants/[id]` detail route is server-rendered and device-agnostic,
// but "Back to caseload" has a variant-dependent destination: the tablet field
// surface returns to the `/` tablet landing it came from; the laptop SPA returns
// to `/caseload`. (Hardcoding `/caseload` dumped tablet users onto the desktop
// console — the bug this fixes.)
//
// Uses the `useDeviceVariant` hook, NOT the synchronous resolver: this is only
// an `<a href>`, not an on-mount redirect, so the one-frame 'laptop' SSR default
// (→ href="/caseload") is harmless — nothing navigates until the user taps, by
// which point the hook has flipped to the real variant. The hook also keeps the
// href reactive if the device crosses the tablet/laptop boundary mid-session.

type Props = {
  readonly children: ReactNode;
} & Pick<ComponentProps<typeof Button>, "variant" | "size" | "className">;

export function BackToCaseloadLink({
  children,
  variant,
  size,
  className,
}: Props) {
  const href = useDeviceVariant() === "tablet" ? "/" : "/caseload";
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <Link href={href}>{children}</Link>
    </Button>
  );
}
