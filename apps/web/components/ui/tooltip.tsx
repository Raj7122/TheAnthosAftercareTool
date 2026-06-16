"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface TooltipProps {
  // Tooltip body — short, plain-language. Referenced by aria-describedby so
  // screen-reader users get it on focus, not only on mouse hover.
  readonly content: ReactNode;
  readonly children: ReactNode;
  // Which side of the trigger the bubble floats on.
  readonly side?: "top" | "bottom";
  // When the wrapped child is ALREADY focusable (a <button>, <a>, etc.), pass
  // `focusable={false}` so the wrapper doesn't add a second tab stop — focusin
  // still bubbles to the wrapper, so the bubble shows on the child's focus.
  // For non-interactive children (a badge <span>), leave it true so keyboard
  // users can reach the description.
  readonly focusable?: boolean;
  // Extra classes for the trigger wrapper.
  readonly className?: string;
}

interface Coords {
  readonly top: number;
  readonly left: number;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;

// The trigger is a non-native wrapper. Per the jsx-a11y rule's own remedy, it
// fully supports mouse (enter/leave), focus, keyboard (Escape), and tabbing
// (tabIndex when `focusable`). There is no native element or ARIA role for
// "tooltip trigger", so the two rules are disabled for this primitive only.
/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-tabindex */

// Hand-rolled, dependency-free tooltip — matches the project precedent of
// building lightweight UI primitives (see FactorBreakdownDrawer) rather than
// pulling in Radix.
//
// The bubble renders in a portal on <body> with `position: fixed`, positioned
// from the trigger's bounding rect. This escapes ancestor `overflow` clipping
// (e.g. the caseload sticky-header scroll region, whose `overflow-y:auto`
// forces `overflow-x:auto`) and ancestor stacking contexts (e.g. the `z-10`
// sticky header vs. `z-10` row chips). The horizontal center is clamped to the
// viewport so triggers near an edge (first/last column) aren't cut off.
//
// Accessibility: wired via `aria-describedby`; Esc dismisses (WCAG 1.4.13);
// `pointer-events-none` keeps the bubble from stealing clicks.
export function Tooltip({
  content,
  children,
  side = "top",
  focusable = true,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const tipId = useId();

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  }, []);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (trigger === null) return;
    const r = trigger.getBoundingClientRect();
    const bw = bubble?.offsetWidth ?? 0;
    const bh = bubble?.offsetHeight ?? 0;
    const half = bw / 2;
    // Clamp the (translateX(-50%)) center so both bubble edges stay on-screen.
    const center = Math.min(
      Math.max(r.left + r.width / 2, VIEWPORT_MARGIN + half),
      window.innerWidth - VIEWPORT_MARGIN - half,
    );
    const top =
      side === "top" ? r.top - bh - TRIGGER_GAP : r.bottom + TRIGGER_GAP;
    setCoords({ top, left: center });
  }, [side]);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    reposition();
    // Keep the bubble pinned to the trigger if the page or an inner scroll
    // container moves while it's open (capture = true catches inner scrolls).
    const onMove = () => reposition();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, reposition]);

  return (
    <span
      ref={triggerRef}
      className={cn("relative inline-flex", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={onKeyDown}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={tipId}
    >
      {children}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            id={tipId}
            style={{
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
            }}
            className={cn(
              "pointer-events-none fixed z-[100] w-max max-w-[16rem] -translate-x-1/2 whitespace-normal rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-normal normal-case leading-snug tracking-normal text-white shadow-md transition-opacity duration-100",
              // Hidden until measured+positioned so it never flashes at 0,0.
              coords === null ? "opacity-0" : "opacity-100",
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
