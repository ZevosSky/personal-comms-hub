import { useAppRuntime } from "../hooks/useAppRuntime.js";

const RIGHT_CORNERS = new Set(["top-right", "bottom-right"]);

// Legacy edge trigger. Main may now use a static page instead; this stays a tiny, harmless view.
export function TriggerView() {
  const { appState, run } = useAppRuntime({ withRuntime: false });
  const corner = appState?.ui?.dockCorner ?? "bottom-left";
  return (
    <div className={`dock-trigger-shell ${RIGHT_CORNERS.has(corner) ? "right-anchored" : "left-anchored"} ${corner}`}>
      <button
        aria-label="Open Comms Hub dock"
        className="dock-trigger-tab"
        onClick={() => run("openDockFromTrigger", [], { quiet: true })}
        title="Open Comms Hub dock"
        type="button"
      />
    </div>
  );
}
