import { contextBridge, ipcRenderer } from "electron";

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
  setDockExpanded: (expanded) => ipcRenderer.invoke("ui:set-dock-expanded", expanded),
  uploadIcon: () => ipcRenderer.invoke("icons:upload"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openUpdateDownload: () => ipcRenderer.invoke("updates:open"),
  notifyServiceEvent: (payload) => ipcRenderer.invoke("notifications:service-event", payload),
  markNotificationsSeen: (serviceId) => ipcRenderer.invoke("notifications:mark-seen", serviceId),
  clearNotificationHistory: () => ipcRenderer.invoke("notifications:clear-history"),
  getGuestPreloadPath: () => ipcRenderer.invoke("paths:get-guest-preload"),
  onStateUpdated: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state:updated", listener);
    return () => ipcRenderer.removeListener("state:updated", listener);
  }
});
