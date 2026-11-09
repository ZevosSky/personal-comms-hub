import { hasBridgeMethod } from "../lib/bridge.js";
import { useShellOverlays } from "../hooks/useShellOverlays.js";
import { BubbleToolbar } from "../components/BubbleToolbar.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { FindBar } from "../components/FindBar.jsx";
import { ServiceViewport } from "../components/ServiceViewport.jsx";
import { ShellDialogs, obscuredCopy } from "./ShellDialogs.jsx";

// Expanded dock "bubble" window: toolbar + the active app.
export function BubbleView({ appState, runtime, run, status, actions, limits, cornerClass }) {
  const services = appState.services.filter((service) => service.isEnabled);
  const activeServiceId = appState.ui.activeServiceId ?? services[0]?.id ?? null;
  const activeService = services.find((service) => service.id === activeServiceId) ?? null;
  const activeRuntime = activeService ? runtime?.services?.[activeService.id] : undefined;
  const overlays = useShellOverlays({ appState, activeServiceId: activeService?.id ?? null, actions, run });
  const findOpen = overlays.findOpen && Boolean(activeService);

  return (
    <div
      className={`bubble-shell ${cornerClass}`}
      onKeyDown={(event) => {
        // Escape in the shell (not in the guest page) collapses the bubble.
        if (event.key !== "Escape" || event.defaultPrevented || overlays.obscuredBy || findOpen) return;
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        event.preventDefault();
        actions.setDockExpanded(false);
      }}
    >
      <BubbleToolbar
        service={activeService}
        runtime={activeRuntime}
        canNavigate={hasBridgeMethod("navigateActive")}
        zoomLimits={limits.zoom}
        status={status.current}
        onDismissStatus={status.dismiss}
        onBack={() => actions.navigate("back")}
        onReload={actions.refreshActive}
        onZoom={actions.setZoom}
        onCollapse={() => actions.setDockExpanded(false)}
        onOpenFull={() => actions.setWindowMode("full")}
      />
      {findOpen ? (
        <FindBar
          key={activeService.id}
          serviceName={activeService.name}
          focusToken={overlays.findToken}
          onClose={overlays.closeFind}
        />
      ) : null}
      <ServiceViewport
        service={activeService}
        runtime={activeRuntime}
        obscured={Boolean(overlays.obscuredBy)}
        {...obscuredCopy(overlays.obscuredBy, overlays.shareRequest)}
        layoutKey={String(findOpen)}
        onReload={actions.refreshActive}
        className="dock-webview-wrap dock-webview-solo"
        emptyState={<EmptyState title="Choose an app from the dock" />}
      />
      <ShellDialogs appState={appState} overlays={overlays} actions={actions} />
    </div>
  );
}
