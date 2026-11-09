import { useLayoutEffect, useRef } from "react";
import { sendBridge, subscribeBridge } from "../lib/bridge.js";
import { EmptyState } from "./EmptyState.jsx";

// Same rounding as main, so sub-pixel jitter doesn't count as a change.
const viewportKey = ({ serviceId, bounds, obscured }) =>
  [
    serviceId,
    Math.round(bounds.x),
    Math.round(bounds.y),
    Math.round(bounds.x + bounds.width),
    Math.round(bounds.y + bounds.height),
    obscured ? 1 : 0
  ].join(":");

// Placeholder for the native WebContentsView. Main lays the guest page over this element's
// rectangle, so nothing drawn inside it is visible unless the viewport is reported `obscured`.
// Bounds are re-reported on resize (ResizeObserver + rAF), when main asks, and whenever
// `layoutKey` changes (e.g. the find bar opening above it). Unchanged reports are skipped, except
// when main asks (onServiceViewportRequested), which is always answered.
export function ServiceViewport({
  service,
  runtime,
  obscured = false,
  obscuredTitle = "App settings are open",
  obscuredBody = "Your app stays loaded while this dialog is open.",
  layoutKey = "",
  className = "",
  onReload,
  emptyState
}) {
  const viewportRef = useRef(null);
  const lastReported = useRef(null);
  const status = runtime?.status;
  const reportObscured = Boolean(obscured || status === "error");
  const serviceId = service?.id ?? null;

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    let frame = 0;
    const report = (force = false) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = {
        serviceId,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        obscured: reportObscured
      };
      const key = viewportKey(viewport);
      if (!force && key === lastReported.current) return;
      if (sendBridge("setServiceViewport", viewport)) lastReported.current = key;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => report());
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    const unsubscribe = subscribeBridge("onServiceViewportRequested", () => report(true));
    report();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      unsubscribe();
    };
  }, [serviceId, reportObscured, status, layoutKey]);

  let content = null;
  if (!service) {
    content = emptyState ?? <EmptyState />;
  } else if (obscured) {
    content = (
      <div className="workspace-overlay-state">
        <h2>{obscuredTitle}</h2>
        <p>{obscuredBody}</p>
      </div>
    );
  } else if (status === "closing") {
    content = (
      <div className="workspace-overlay-state">
        <h2>Reopening {service.name}</h2>
        <p>Waiting for this page to finish closing. Your app will reopen automatically.</p>
      </div>
    );
  } else if (status === "error") {
    content = (
      <div className="workspace-overlay-state is-error">
        <h2>{runtime?.retryAt ? `Can't reach ${service.name}` : `Unable to load ${service.name}`}</h2>
        <p>
          {runtime?.retryAt
            ? "You seem to be offline. Comms Hub will retry automatically."
            : runtime?.error || "Check the connection or app URL, then try again."}
        </p>
        <button type="button" className="primary-button" onClick={onReload}>
          Reload now
        </button>
      </div>
    );
  }

  return (
    <div ref={viewportRef} className={`service-viewport ${className}`}>
      {content}
    </div>
  );
}
