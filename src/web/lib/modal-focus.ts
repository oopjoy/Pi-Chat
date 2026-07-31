import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Gives aria-modal dialogs the keyboard behavior their semantics promise:
 * focus enters the dialog, Tab stays inside it, and focus returns to its opener.
 */
export function useModalFocus(active: boolean, dialogRef: RefObject<HTMLElement | null>, initialFocus?: () => HTMLElement | null) {
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusInitial = () => (initialFocus?.() || dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const schedule = window.requestAnimationFrame || ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    const cancel = window.cancelAnimationFrame || window.clearTimeout;
    const frame = schedule(focusInitial);
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const elements = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hasAttribute("disabled"));
      if (!elements.length) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      cancel(frame);
      document.removeEventListener("keydown", trap);
      if (opener?.isConnected) opener.focus();
    };
  }, [active, dialogRef, initialFocus]);
}
