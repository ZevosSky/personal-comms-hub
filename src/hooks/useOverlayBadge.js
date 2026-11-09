import { useEffect, useRef } from "react";
import { hasBridgeMethod, invokeBridge } from "../lib/bridge.js";
import { renderOverlayBadge } from "../lib/misc.js";

const DEBOUNCE_MS = 300;

// Windows taskbar overlay with the total unread count (full-mode renderer only).
export function useOverlayBadge(total, enabled) {
  const lastSent = useRef(undefined);

  useEffect(() => {
    if (!enabled || !hasBridgeMethod("setOverlayBadge")) return undefined;
    const count = Math.max(0, Math.floor(Number(total) || 0));
    if (lastSent.current === count) return undefined;
    const timer = setTimeout(() => {
      lastSent.current = count;
      invokeBridge("setOverlayBadge", { count, dataUrl: count ? renderOverlayBadge(count) : null }).catch(() => {
        // Cosmetic only; retry on the next change.
        lastSent.current = undefined;
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [total, enabled]);
}
