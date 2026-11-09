import { useMemo } from "react";
import { hasBridgeMethod } from "../lib/bridge.js";
import { computeServiceBadges } from "../lib/badges.js";
import { DockRail } from "../components/DockRail.jsx";

// Narrow dock window. No room for status text, so errors show as a "!" button.
export function DockView({ appState, runtime, status, actions, cornerClass }) {
  const services = useMemo(() => appState.services.filter((service) => service.isEnabled), [appState.services]);
  const allIds = useMemo(() => appState.services.map((service) => service.id), [appState.services]);
  const badges = useMemo(() => computeServiceBadges(appState, runtime), [appState, runtime]);
  const activeId = appState.ui.activeServiceId ?? services[0]?.id ?? null;
  const error = status.current?.tone === "error" ? status.current : null;

  return (
    <div className={`dock-shell ${cornerClass}`}>
      <div className="dock-body">
        <DockRail
          services={services}
          allIds={allIds}
          activeId={activeId}
          runtimeServices={runtime?.services ?? {}}
          badges={badges}
          onSelect={actions.selectService}
          onReorder={actions.reorder}
          onContextMenu={hasBridgeMethod("showServiceContextMenu") ? actions.showContextMenu : undefined}
          onReload={actions.refreshActive}
          onCycleCorner={actions.cycleDockCorner}
          onOpenFull={() => actions.setWindowMode("full")}
          error={error}
          onDismissError={() => error && status.dismiss(error.id)}
        />
      </div>
    </div>
  );
}
