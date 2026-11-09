import { useEffect } from "react";
import { subscribeBridge } from "../lib/bridge.js";
import { useLatest } from "./useLatest.js";

// Subscribes to a window.commsApp event for the component's lifetime. Missing events are a no-op.
export function useBridgeEvent(eventName, handler, enabled = true) {
  const handlerRef = useLatest(handler);
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeBridge(eventName, (...args) => {
      try {
        handlerRef.current?.(...args);
      } catch {
        // A bad payload must not break the IPC listener.
      }
    });
  }, [eventName, enabled, handlerRef]);
}
