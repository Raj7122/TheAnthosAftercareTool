"use client";

import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

import { orderQueueIds, queueDescription, queueLabel } from "../_lib/queue-labels";

interface Props {
  readonly queueCounts: Readonly<Record<string, number>>;
  readonly activeQueueId: string;
  readonly onSelect: (queueId: string) => void;
  readonly disabled?: boolean;
}

// BR-23 — queue selector with counts (e.g. "Due soon (12)"). Render order
// comes from `orderQueueIds` so cache-warm (JSONB-normalized key order)
// and cache-cold (insertion order) paths produce identical tab order
// (AC-12). Styling matches the wireframe `tool-queue-tab` pill — F-13
// tap-target sizing will be re-evaluated in the next portrait pass.
export function QueueSelector({ queueCounts, activeQueueId, onSelect, disabled = false }: Props) {
  const queues = orderQueueIds(queueCounts);
  return (
    <nav aria-label="Queue selector" className="flex flex-wrap gap-1" data-testid="queue-selector">
      {queues.map((id) => {
        const isActive = id === activeQueueId;
        const description = queueDescription(id);
        const button = (
          <button
            type="button"
            aria-current={isActive ? "page" : undefined}
            disabled={disabled}
            onClick={() => onSelect(id)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 px-3.5 py-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
              isActive ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
            )}
            data-queue-id={id}
          >
            <span>{queueLabel(id)}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums",
                // Active count badge: `bg-white/15` on the dark button blended
                // to ~#f3f3f5 against white text → contrast 1.1:1, fails
                // WCAG 2.1 AA 4.5:1 (P3B-05). Switched to `bg-zinc-700` —
                // zinc-700 (#3f3f46) with white text computes to ~10.3:1.
                isActive ? "bg-zinc-700 text-white" : "bg-white text-zinc-600",
              )}
            >
              {queueCounts[id] ?? 0}
            </span>
          </button>
        );
        // The <button> is the tab stop; `focusable={false}` keeps the wrapper
        // out of the tab order while focusin still surfaces the bubble.
        return description === null ? (
          <span key={id}>{button}</span>
        ) : (
          <Tooltip key={id} content={description} side="bottom" focusable={false}>
            {button}
          </Tooltip>
        );
      })}
    </nav>
  );
}
