import { describeError } from "../lib/bridge.js";
import { moveAmongVisible } from "../lib/order.js";

const DOCK_CORNERS = ["bottom-left", "bottom-right", "top-right", "top-left"];

// All user actions, expressed through the single `run` bridge wrapper.
export function useServiceActions({ appState, run, notify, mode }) {
  const services = appState?.services ?? [];
  const ui = appState?.ui ?? {};
  const visibleIds = services.filter((service) => service.isEnabled).map((service) => service.id);
  const allIds = services.map((service) => service.id);
  const find = (id) => services.find((service) => service.id === id) ?? null;

  // `quiet` leaves failures to the caller (the Add/Edit dialog shows them itself).
  const saveService = (payload, success, { quiet = false } = {}) =>
    run("saveService", [payload], { success, failure: "Couldn't save the app", quiet });

  const reorder = (nextIds) => run("reorderServices", [nextIds], { failure: "Couldn't reorder apps" });

  return {
    async selectService(serviceId) {
      if (mode === "dock") {
        // dockExpanded defaults to true in main's state.
        const expanded = ui.dockExpanded !== false;
        if (serviceId === ui.activeServiceId && expanded) {
          return run("setDockExpanded", [false], { failure: "Couldn't collapse the dock" });
        }
        const selected = await run("setActiveService", [serviceId], { failure: "Couldn't switch apps" });
        // Only a collapsed dock needs the extra round trip to open the bubble.
        if (!selected.ok || expanded) return selected;
        return run("setDockExpanded", [true], { failure: "Couldn't open the app" });
      }
      return run("setActiveService", [serviceId], { failure: "Couldn't switch apps" });
    },
    setZoom(serviceId, zoomFactor) {
      if (!serviceId) return undefined;
      return run("setServiceZoom", [serviceId, zoomFactor], { failure: "Couldn't change zoom" });
    },
    async refreshActive() {
      const result = await run("refreshActiveWebview", [], { applyResult: false, failure: "Couldn't reload" });
      if (result.ok && result.value === false) notify("No app is open to reload.", "info");
      return result;
    },
    navigate(action) {
      return run("navigateActive", [action], { applyResult: false, failure: "Couldn't navigate" });
    },
    saveService,
    // `quiet` as for saveService: the Add/Edit dialog shows a failure itself.
    async removeService(serviceId, { quiet = false } = {}) {
      const target = find(serviceId);
      if (!target || target.isBuiltIn) return { ok: false };
      const result = await run("removeService", [serviceId], { failure: `Couldn't remove ${target.name}`, quiet });
      // Main asks for confirmation natively; null means the user cancelled.
      if (result.ok && result.value === null) return { ok: false, cancelled: true };
      if (result.ok) notify(`Removed ${target.name}.`, "info");
      return result;
    },
    hideService(serviceId) {
      const target = find(serviceId);
      if (!target?.isBuiltIn) return undefined;
      return saveService(
        { ...target, isEnabled: false, keepAliveInBackground: false },
        `Hid ${target.name} on this device.`
      );
    },
    restoreService(serviceId) {
      const target = find(serviceId);
      if (!target) return undefined;
      return saveService({ ...target, isEnabled: true }, `Restored ${target.name}.`);
    },
    reorder,
    moveService(serviceId, direction) {
      const next = moveAmongVisible(allIds, visibleIds, serviceId, direction);
      return next ? reorder(next) : undefined;
    },
    saveNotificationSettings(service, updates) {
      if (!service) return undefined;
      return saveService({
        ...service,
        notificationSettings: { ...service.notificationSettings, ...updates }
      });
    },
    toggleKeepAlive(service) {
      if (!service) return undefined;
      return saveService({ ...service, keepAliveInBackground: !service.keepAliveInBackground });
    },
    async sleepService(service) {
      if (!service) return undefined;
      const result = await run("sleepService", [service.id], {
        applyResult: false,
        failure: `Couldn't put ${service.name} to sleep`
      });
      // null: main asked about the app's open windows and the user cancelled.
      if (result.ok && result.value !== null) {
        notify(
          result.value
            ? `${service.name} is asleep. Alerts are paused until you open it.`
            : `${service.name} can't sleep right now.`,
          "info"
        );
      }
      return result;
    },
    async sendTestAlert(service) {
      if (!service) return undefined;
      const result = await run(
        "notifyServiceEvent",
        [
          {
            serviceId: service.id,
            serviceName: service.name,
            source: "test",
            title: `${service.name} test alert`,
            body: "This is a sample notification from Comms Hub."
          }
        ],
        { applyResult: false, failure: "Couldn't send a test alert" }
      );
      if (result.ok) {
        notify(
          result.value === false
            ? "Test alert recorded. Turn on desktop notifications to see a toast."
            : `Sent a test alert for ${service.name}.`,
          "info"
        );
      }
      return result;
    },
    showContextMenu(serviceId) {
      return run("showServiceContextMenu", [serviceId], { applyResult: false, quiet: true });
    },
    // Returns { iconSource } (null when the picker was cancelled) or { error }. Errors are shown
    // by the Add/Edit dialog, whose backdrop covers the status area.
    async uploadIcon() {
      const result = await run("uploadIcon", [], { applyResult: false, quiet: true });
      if (!result.ok) return { error: `Couldn't use that icon: ${describeError(result.error)}` };
      return { iconSource: typeof result.value === "string" ? result.value : null };
    },
    setNotificationsEnabled(enabled) {
      return run("setNotificationsEnabled", [enabled], { failure: "Couldn't change notifications" });
    },
    setMemorySaverEnabled(enabled) {
      return run("setMemorySaverEnabled", [enabled], { failure: "Couldn't change memory saver" });
    },
    setAppSettings(partial) {
      return run("setAppSettings", [partial], { failure: "Couldn't save the setting" });
    },
    setSidebarCollapsed(collapsed) {
      return run("setSidebarCollapsed", [collapsed], { failure: "Couldn't toggle settings" });
    },
    setWindowMode(nextMode) {
      return run("setWindowMode", [nextMode], { failure: "Couldn't switch window mode" });
    },
    setDockExpanded(expanded) {
      return run("setDockExpanded", [expanded], { failure: "Couldn't resize the dock" });
    },
    setDockHeight(height) {
      return run("setDockHeight", [height], { failure: "Couldn't change the dock height" });
    },
    cycleDockCorner() {
      const index = DOCK_CORNERS.indexOf(ui.dockCorner ?? "bottom-left");
      return run("setDockCorner", [DOCK_CORNERS[(index + 1) % DOCK_CORNERS.length]], {
        failure: "Couldn't move the dock"
      });
    },
    openDockFromTrigger() {
      return run("openDockFromTrigger", [], { failure: "Couldn't open the dock" });
    }
  };
}
