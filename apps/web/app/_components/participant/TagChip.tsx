import { memo } from "react";

import type { RowTag } from "@anthos/api";

import { Badge } from "@/components/ui/badge";

import { tagChipTooltip } from "./tag-chip-tooltip";
import { tagChipVariant } from "./tag-chip-variant";

interface Props {
  readonly tag: RowTag;
}

function TagChipImpl({ tag }: Props) {
  return (
    <Badge
      variant={tagChipVariant(tag.severity)}
      title={tagChipTooltip(tag)}
      className="text-[11px]"
    >
      {tag.label}
    </Badge>
  );
}

export const TagChip = memo(TagChipImpl);
