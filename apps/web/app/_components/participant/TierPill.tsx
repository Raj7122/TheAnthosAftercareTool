import { memo } from "react";

import { tierPillVariant } from "./tier-pill-variant";

interface Props {
  readonly tier: number | null;
}

function TierPillImpl({ tier }: Props) {
  const variant = tierPillVariant(tier);
  if (variant === null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  return (
    <span
      title={variant.tooltip}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${variant.pillClassName}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-3 rounded-full ${variant.glyphClassName}`}
      />
      <span>
        {variant.numeral} {variant.label}
      </span>
    </span>
  );
}

export const TierPill = memo(TierPillImpl);
