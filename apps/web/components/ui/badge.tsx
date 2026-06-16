import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        outline: "text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        tier1: "border-transparent bg-tier1 text-white",
        tier2: "border-transparent bg-tier2 text-white",
        tier3: "border-transparent bg-tier3 text-white",
        cycleComplete: "border-transparent bg-cycleComplete text-white",
        cycleDue: "border-transparent bg-cycleDue text-white",
        cycleOverdue: "border-transparent bg-cycleOverdue text-white",
        cycleCatchUp: "border-transparent bg-cycleCatchUp text-white",
        barrierHigh: "border-transparent bg-barrierHigh text-white",
        barrierMedium: "border-transparent bg-barrierMedium text-white",
        barrierLow: "border-transparent bg-barrierLow text-white",
        info: "border-transparent bg-tagInfo text-white",
        // P1H-14 — Aftercare Extended program-modifier pill (PARTICIPANT
        // cell). Raw palette mirrors the P1H-10 snoozed pill at
        // CaseloadRow.tsx (the violet soft-pill variant): no existing
        // emerald usage in the app, so no semantic-token collision. Pair
        // with `rounded-full` on the consumer for the spec'd pill shape.
        programModifier:
          "border-transparent bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
