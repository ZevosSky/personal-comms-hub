import { hasBridgeMethod } from "../lib/bridge.js";
import { useServiceMetrics } from "../hooks/useServiceMetrics.js";
import { AppsSection } from "./sidebar/AppsSection.jsx";
import { SettingsSection } from "./sidebar/SettingsSection.jsx";
import { ThisAppSection } from "./sidebar/ThisAppSection.jsx";

// Settings sidebar of the full window: the selected app, all apps, then global settings.
export function Sidebar({
  appState,
  runtime,
  services,
  hiddenServices,
  activeService,
  limits,
  badges,
  actions,
  updates,
  onEdit
}) {
  // Mounted only while the sidebar is open; the hook also pauses while the window is hidden.
  const { metrics, supported: metricsSupported, failed: metricsFailed } = useServiceMetrics(true);
  const runtimeServices = runtime?.services ?? {};
  const activeIndex = services.findIndex((service) => service.id === activeService?.id);
  const can = {
    navigate: hasBridgeMethod("navigateActive"),
    sleep: hasBridgeMethod("sleepService")
  };

  return (
    <aside className="sidebar" aria-label="Settings">
      {activeService ? (
        <ThisAppSection
          service={activeService}
          runtime={runtimeServices[activeService.id]}
          ui={appState.ui}
          metric={metrics?.services?.[activeService.id]}
          metricsSupported={metricsSupported}
          zoomLimits={limits.zoom}
          canMoveUp={activeIndex > 0}
          canMoveDown={activeIndex >= 0 && activeIndex < services.length - 1}
          can={can}
          actions={actions}
          onEdit={() => onEdit(activeService.id)}
        />
      ) : (
        <section className="sidebar-section">
          <p className="eyebrow">This app</p>
          <p className="setting-hint">No app is selected. Pick one from the rail or add a new one.</p>
        </section>
      )}

      <AppsSection
        services={services}
        hiddenServices={hiddenServices}
        activeId={activeService?.id ?? null}
        runtimeServices={runtimeServices}
        ui={appState.ui}
        metrics={metrics}
        badges={badges}
        canSleep={can.sleep}
        onSelect={actions.selectService}
        onSleep={actions.sleepService}
        onRestore={actions.restoreService}
      />

      <SettingsSection
        ui={appState.ui}
        limits={limits}
        capabilities={appState.capabilities}
        metrics={metrics}
        metricsSupported={metricsSupported}
        metricsFailed={metricsFailed}
        settingsSupported={hasBridgeMethod("setAppSettings")}
        actions={actions}
        updates={updates}
      />
    </aside>
  );
}
