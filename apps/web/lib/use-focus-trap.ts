"use client";

import { useEffect, type RefObject } from "react";

// Trap Tab/Shift-Tab focus inside the referenced container while it is
// mounted. `role="dialog" aria-modal="true"` declares the modal intent to
// the accessibility tree, but browsers do NOT actually prevent Tab from
// reaching siblings outside the dialog — explicit cycling is required.
//
// Initial focus is the caller's responsibility (each sheet focuses its
// first interactive control in a `useEffect`); this hook handles Tab
// cycling only, and restores the previously-focused element on unmount.
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const containerEl = containerRef.current;
    if (containerEl === null) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== "Tab") return;
      const focusables = collectFocusable(containerEl);
      if (focusables.length === 0) {
        ev.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const focused = document.activeElement as HTMLElement | null;
      if (ev.shiftKey) {
        if (focused === first || focused === null || !containerEl.contains(focused)) {
          ev.preventDefault();
          last.focus();
        }
      } else {
        if (focused === last || focused === null || !containerEl.contains(focused)) {
          ev.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused !== null && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function collectFocusable(container: HTMLElement): ReadonlyArray<HTMLElement> {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => !el.hasAttribute("aria-hidden"));
}
