import { useMemo } from "react";
import { hasBridgeMethod } from "../lib/bridge.js";
import { computeServiceBadges, totalBadgeCount } from "../lib/badges.js";
import { useOverlayBadge } from "../hooks/useOverlayBadge.js";
import { useShellOverlays } from "../hooks/useShellOverlays.js";
import { useSidebarVisibility } from "../hooks/useSidebarVisibility.js";
import { useUpdates } from "../hooks/useUpdates.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { FindBar } from "../components/FindBar.jsx";
import { Rail } from "../components/Rail.jsx";
import { ServiceViewport } from "../components/ServiceViewport.jsx";
import { Sidebar } from "../components/Sidebar.jsx";
import { Titlebar } from "../components/Titlebar.jsx";
import { ShellDialogs, obscuredCopy } from "./ShellDialogs.jsx";

const DEFAULT_DOCK_UNAVAILABLE =
  "Floating dock and pop-out are temporarily unavailable on Linux. Use the full app.";

export function FullView({ appState, runtime, run, status, actions, limits }) {
  const services = useMemo(() => appState.services.filter((service) => service.isEnabled), [appState.services]);
  const hiddenServices = useMemo(() => appState.services.filter((service) => !service.isEnabled), [appState.services]);
  const allIds = useMemo(() => appState.services.map((service) => service.id), [appState.services]);
  const activeServiceId = appState.ui.activeServiceId ?? services[0]?.id ?? null;
  const activeService = services.find((service) => service.id === activeServiceId) ?? null;
  const runtimeServices = runtime?.services ?? {};
  const activeRuntime = activeService ? runtimeServices[activeService.id] : undefined;
  const badges = useMemo(() => computeServiceBadges(appState, runtime), [appState, runtime]);
  const sidebar = useSidebarVisibility(Boolean(appState.ui.sidebarCollapsed), actions.setSidebarCollapsed);
  const sidebarOpen = sidebar.open;
  const dockModeSupported = appState.capabilities?.dockModeSupported ?? false;

  useOverlayBadge(totalBadgeCount(badges), true);
  const updates = useUpdates({ run, notify: status.notify, autoCheck: true });
  const overlays = useShellOverlays({ appState, activeServiceId: activeService?.id ?? null, actions, run });
  const findOpen = overlays.findOpen && Boolean(activeService);

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <Titlebar
        activeService={activeService}
        activeRuntime={activeRuntime}
        canNavigate={hasBridgeMethod("navigateActive")}
        canFind={overlays.canFind}
        findOpen={findOpen}
        status={status.current}
        onDismissStatus={status.dismiss}
        onNavigate={actions.navigate}
        onReload={actions.refreshActive}
        onFind={() => (findOpen ? overlays.closeFind() : overlays.openFind())}
        dockModeSupported={dockModeSupported}
        dockUnavailableReason={appState.capabilities?.dockModeUnavailableReason ?? DEFAULT_DOCK_UNAVAILABLE}
        onDockMode={() => actions.setWindowMode("dock")}
      />

      <Rail
        services={services}
        allIds={allIds}
        activeId={activeService?.id ?? null}
        runtimeServices={runtimeServices}
        badges={badges}
        onSelect={actions.selectService}
        onReorder={actions.reorder}
        onContextMenu={hasBridgeMethod("showServiceContextMenu") ? actions.showContextMenu : undefined}
        sidebarOpen={sidebarOpen}
        onAddApp={overlays.openCreate}
        onToggleSidebar={sidebar.toggle}
      />

      {sidebarOpen ? (
        <Sidebar
          appState={appState}
          runtime={runtime}
          services={services}
          hiddenServices={hiddenServices}
          activeService={activeService}
          limits={limits}
          badges={badges}
          actions={actions}
          updates={updates}
          onEdit={overlays.openEdit}
        />
      ) : null}

      <main className="workspace">
        {findOpen ? (
          <FindBar
            key={activeService.id}
            serviceName={activeService.name}
            focusToken={overlays.findToken}
            onClose={overlays.closeFind}
          />
        ) : null}
        <div className="workspace-body">
          <ServiceViewport
            service={activeService}
            runtime={activeRuntime}
            obscured={Boolean(overlays.obscuredBy)}
            {...obscuredCopy(overlays.obscuredBy, overlays.shareRequest)}
            layoutKey={`${sidebarOpen}:${findOpen}`}
            onReload={actions.refreshActive}
            emptyState={
              services.length ? (
                <EmptyState />
              ) : (
                <EmptyState
                  eyebrow="Welcome"
                  title="No apps yet"
                  body={
                    hiddenServices.length
                      ? "Add a web app, or restore a hidden one from Settings."
                      : "Add the web apps you message with, like Gmail, Slack or Discord."
                  }
                  action={
                    <button type="button" className="primary-button" onClick={overlays.openCreate}>
                      Add an app
                    </button>
                  }
                />
              )
            }
          />
        </div>
      </main>

      <ShellDialogs appState={appState} overlays={overlays} actions={actions} />
    </div>
  );
}
