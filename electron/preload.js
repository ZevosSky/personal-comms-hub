const { contextBridge, ipcRenderer } = require("electron");

// Returns an unsubscribe function, like onStateUpdated.
const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("commsApp", {
  getState: () => ipcRenderer.invoke("app-state:get"),
  saveService: (service) => ipcRenderer.invoke("services:save", service),
  removeService: (serviceId) => ipcRenderer.invoke("services:remove", serviceId),
  reorderServices: (serviceIds) => ipcRenderer.invoke("services:reorder", serviceIds),
  setActiveService: (serviceId) => ipcRenderer.invoke("ui:set-active-service", serviceId),
  setNotificationsEnabled: (enabled) => ipcRenderer.invoke("ui:set-notifications", enabled),
  setMemorySaverEnabled: (enabled) => ipcRenderer.invoke("ui:set-memory-saver", enabled),
  setSidebarCollapsed: (collapsed) => ipcRenderer.invoke("ui:set-sidebar-collapsed", collapsed),
  setAppSettings: (partial) => ipcRenderer.invoke("ui:set-settings", partial),
  setWindowMode: (mode) => ipcRenderer.invoke("ui:set-window-mode", mode),
  setDockCorner: (corner) => ipcRenderer.invoke("ui:set-dock-corner", corner),
  setDockHeight: (height) => ipcRenderer.invoke("ui:set-dock-height", height),
  setBubbleSize: (size) => ipcRenderer.invoke("ui:set-bubble-size", size),
  setServiceZoom: (serviceId, zoomFactor) => ipcRenderer.invoke("services:set-zoom", { serviceId, zoomFactor }),
  setServiceViewport: (viewport) => ipcRenderer.send("services:set-viewport", viewport),
  getServiceRuntime: () => ipcRenderer.invoke("services:get-runtime"),
  sleepService: (serviceId) => ipcRenderer.invoke("services:sleep", serviceId),
  getServiceMetrics: () => ipcRenderer.invoke("services:get-metrics"),
  setOverlayBadge: (badge) => ipcRenderer.invoke("app:set-overlay-badge", badge),
  setDockExpanded: (expanded) => ipcRenderer.invoke("ui:set-dock-expanded", expanded),
  openDockFromTrigger: () => ipcRenderer.invoke("ui:open-dock-from-trigger"),
  refreshActiveWebview: () => ipcRenderer.invoke("webviews:refresh-active"),
  uploadIcon: () => ipcRenderer.invoke("icons:upload"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openUpdateDownload: () => ipcRenderer.invoke("updates:open"),
  notifyServiceEvent: (payload) => ipcRenderer.invoke("notifications:service-event", payload),
  markNotificationsSeen: (serviceId) => ipcRenderer.invoke("notifications:mark-seen", serviceId),
  clearNotificationHistory: () => ipcRenderer.invoke("notifications:clear-history"),
  respondToScreenShare: (response) => ipcRenderer.invoke("screen-share:respond", response),
  // action: "back" | "forward" | "home" | "open-in-browser"
  navigateActive: (action) => ipcRenderer.invoke("services:navigate", action),
  // findNext: true for "next match" of the same text; resolves a request id, or null.
  findInPage: (text, options) =>
    ipcRenderer.invoke("services:find", text, {
      forward: options?.forward !== false,
      findNext: options?.findNext === true,
      matchCase: options?.matchCase === true
    }),
  stopFindInPage: (action) => ipcRenderer.invoke("services:stop-find", action),
  showServiceContextMenu: (serviceId) => ipcRenderer.invoke("services:context-menu", serviceId),
  onStateUpdated: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state:updated", listener);
    return () => ipcRenderer.removeListener("state:updated", listener);
  },
  onServiceRuntimeUpdated: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("services:runtime-updated", listener);
    return () => ipcRenderer.removeListener("services:runtime-updated", listener);
  },
  onServiceViewportRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("services:request-viewport", listener);
    return () => ipcRenderer.removeListener("services:request-viewport", listener);
  },
  // Subscribing tells main this window renders the in-app picker; without one it uses a native dialog.
  onScreenShareRequest: (callback) => {
    const unsubscribe = subscribe("screen-share:request", callback);
    ipcRenderer.send("screen-share:picker", true);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unsubscribe();
      ipcRenderer.send("screen-share:picker", false);
    };
  },
  onScreenShareCancelled: (callback) => subscribe("screen-share:cancelled", callback),
  onStatusMessage: (callback) => subscribe("ui:status", callback),
  onFindResult: (callback) => subscribe("services:find-result", callback),
  onFindRequested: (callback) => subscribe("ui:find-requested", callback),
  onEditServiceRequested: (callback) => subscribe("ui:edit-service", callback)
});
