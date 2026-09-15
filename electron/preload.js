const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commsApp", {
  getState: () => ipcRenderer.invoke("app-state:get"),
  saveService: (service) => ipcRenderer.invoke("services:save", service),
  removeService: (serviceId) => ipcRenderer.invoke("services:remove", serviceId),
  reorderServices: (serviceIds) => ipcRenderer.invoke("services:reorder", serviceIds),
  setActiveService: (serviceId) => ipcRenderer.invoke("ui:set-active-service", serviceId),
  setNotificationsEnabled: (enabled) => ipcRenderer.invoke("ui:set-notifications", enabled),
  setMemorySaverEnabled: (enabled) => ipcRenderer.invoke("ui:set-memory-saver", enabled),
  setSidebarCollapsed: (collapsed) => ipcRenderer.invoke("ui:set-sidebar-collapsed", collapsed),
  setWindowMode: (mode) => ipcRenderer.invoke("ui:set-window-mode", mode),
  setDockCorner: (corner) => ipcRenderer.invoke("ui:set-dock-corner", corner),
  setDockHeight: (height) => ipcRenderer.invoke("ui:set-dock-height", height),
  setBubbleSize: (size) => ipcRenderer.invoke("ui:set-bubble-size", size),
  setServiceZoom: (serviceId, zoomFactor) => ipcRenderer.invoke("services:set-zoom", { serviceId, zoomFactor }),
  setServiceViewport: (viewport) => ipcRenderer.send("services:set-viewport", viewport),
  getServiceRuntime: () => ipcRenderer.invoke("services:get-runtime"),
  setDockExpanded: (expanded) => ipcRenderer.invoke("ui:set-dock-expanded", expanded),
  openDockFromTrigger: () => ipcRenderer.invoke("ui:open-dock-from-trigger"),
  refreshActiveWebview: () => ipcRenderer.invoke("webviews:refresh-active"),
  uploadIcon: () => ipcRenderer.invoke("icons:upload"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openUpdateDownload: () => ipcRenderer.invoke("updates:open"),
  notifyServiceEvent: (payload) => ipcRenderer.invoke("notifications:service-event", payload),
  markNotificationsSeen: (serviceId) => ipcRenderer.invoke("notifications:mark-seen", serviceId),
  clearNotificationHistory: () => ipcRenderer.invoke("notifications:clear-history"),
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
  }
});
