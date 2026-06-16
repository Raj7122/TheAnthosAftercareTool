"use client";

import { useRef } from "react";
import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface Props {
  readonly value: string;
  readonly onChange: (query: string) => void;
  // Number of participants matching the current query — surfaced to screen
  // readers via the polite live region. Only meaningful while searching.
  readonly resultCount?: number;
  // Id of the list this input filters, wired to `aria-controls` so AT users
  // know the input governs the table below it.
  readonly controlsId?: string;
}

// Desktop caseload participant search. View-layer only: the query is held in
// CaseloadView state and never enters the URL/log (PII — `displayName`). The
// input is full-width and sits in its own row above the table per the approved
// UX placement. A search icon anchors it as a search affordance; the clear
// button (and Esc) reset the query and return focus to the field.
export function ParticipantSearch({
  value,
  onChange,
  resultCount,
  controlsId,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasQuery = value.trim().length > 0;

  const clear = () => {
    onChange("");
    inputRef.current?.focus();
  };

  return (
    <div role="search" className="relative" data-testid="participant-search">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={2}
      />
      <input
        ref={inputRef}
        type="text"
        inputMode="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && hasQuery) {
            e.preventDefault();
            clear();
          }
        }}
        placeholder="Search participants"
        aria-label="Search participants"
        aria-controls={controlsId}
        className={cn(
          "w-full rounded-xl border border-zinc-200 bg-background py-2.5 pl-9 pr-9 text-sm text-foreground",
          "placeholder:text-muted-foreground",
          "transition-colors focus-visible:border-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        data-testid="participant-search-input"
      />
      {hasQuery && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="participant-search-clear"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      )}
      {/* Polite live region — announces the filtered count to screen readers,
          consistent with the sort live-region pattern in CaseloadList. */}
      <p className="sr-only" role="status" aria-live="polite">
        {hasQuery && resultCount !== undefined
          ? `${resultCount} participant${resultCount === 1 ? "" : "s"} match`
          : ""}
      </p>
    </div>
  );
}
