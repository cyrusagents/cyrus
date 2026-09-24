"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { POPUP_NAV_KEYS } from "../lib/popup";

/**
 * Gates a popup's keyboard focus ring on keyboard use.
 *
 * Rows take focus as a popup opens (the primitive's own autofocus, or the
 * popup's first-row focus), and Chrome grants `:focus-visible` to any
 * script-driven focus — so without a gate every pointer-opened popup would
 * open with a ring on its first row. The flag is seeded at open from the
 * element that has focus then: a trigger reached by keyboard matches
 * `:focus-visible`, a clicked one doesn't. Navigation keys inside the popup
 * earn the ring afterwards. Attach `trackKeyboardNav` in the CAPTURE phase —
 * the primitive moves focus during its own keydown handling, so the flag
 * must be set before then.
 */
export function useKeyboardNavGate(open: boolean) {
  const keyboardNavRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    // Script focus inherits :focus-visible from the previously focused
    // element, so this reads the same whether the trigger still has focus
    // or the primitive has already moved it into the popup.
    const active = document.activeElement;
    keyboardNavRef.current =
      active instanceof HTMLElement && active.matches(":focus-visible");
  }, [open]);

  const trackKeyboardNav = useCallback((e: KeyboardEvent) => {
    if (POPUP_NAV_KEYS.includes(e.key)) keyboardNavRef.current = true;
  }, []);

  return { keyboardNavRef, trackKeyboardNav };
}
