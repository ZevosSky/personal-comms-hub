import { useEffect } from "react";
import { getFocusable } from "../lib/misc.js";
import { useLatest } from "./useLatest.js";

// Only the top-most open dialog handles Escape / Tab.
const dialogStack = [];

// Modal behaviour: initial focus, Tab focus trap, Escape, and focus restore on close.
export function useDialog(dialogRef, { initialFocusRef, onEscape } = {}) {
  const onEscapeRef = useLatest(onEscape);

  useEffect(() => {
    const token = {};
    dialogStack.push(token);
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const isTop = () => dialogStack[dialogStack.length - 1] === token;
    const focusInitial = () => {
      const initial = initialFocusRef?.current ?? getFocusable(dialog)[0] ?? dialog;
      initial?.focus?.();
    };
    focusInitial();

    // A dialog can open while a guest page holds keyboard focus; main hands focus to this window
    // afterwards. Make sure it then lands inside the dialog so Esc/Tab/arrows work at once.
    const onWindowFocus = () => {
      if (isTop() && dialog && !dialog.contains(document.activeElement)) focusInitial();
    };

    const onKeyDown = (event) => {
      if (!isTop() || !dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const items = getFocusable(dialog);
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focus", onWindowFocus);
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
    // Runs once per open dialog; refs are stable.
  }, []);
}

export const hasOpenDialog = () => dialogStack.length > 0;
