import { useEffect, useRef, useState } from "react";
import { hasBridgeMethod, invokeBridge } from "../lib/bridge.js";

const POLL_MS = 5000;

// Polls getServiceMetrics every 5 s while `enabled` and the window is visible.
export function useServiceMetrics(enabled) {
  const supported = hasBridgeMethod("getServiceMetrics");
  const [metrics, setMetrics] = useState(null);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !supported) return undefined;
    let cancelled = false;
    let timer = null;

    const sample = async () => {
      if (inFlight.current || document.visibilityState !== "visible") return;
      inFlight.current = true;
      try {
        const next = await invokeBridge("getServiceMetrics");
        if (cancelled) return;
        if (next && typeof next === "object") {
          setMetrics(next);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        inFlight.current = false;
      }
    };
    const start = () => {
      if (timer !== null) return;
      sample();
      timer = setInterval(sample, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => (document.visibilityState === "visible" ? start() : stop());

    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, supported]);

  return { metrics: supported ? metrics : null, supported, failed };
}
