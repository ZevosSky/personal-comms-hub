// DEV-only stand-in for the preload bridge so the renderer can be previewed with `npx vite`
// in a plain browser. Imported only behind `import.meta.env.DEV`; never part of a build.
// Console helpers: window.__commsMock.{shareRequest(audio, foreignOrigin), shareCancelled(requestId),
// status(text, tone), editRequest(id), findRequest(), viewportRequest(), setStatus(id, status),
// unread(id, n)}.

const svgIcon = (fill, letter) =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${fill}"/><text x="32" y="42" font-family="Segoe UI,Arial" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`
  )}`;

const thumb = (fill, label) =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${fill}"/><rect x="16" y="16" width="288" height="24" rx="6" fill="rgba(255,255,255,.35)"/><text x="160" y="110" font-family="Segoe UI,Arial" font-size="22" fill="#fff" text-anchor="middle">${label}</text></svg>`
  )}`;

const icons = {
  gmail: svgIcon("#ea4335", "G"),
  discord: svgIcon("#5865f2", "D"),
  messenger: svgIcon("#a334fa", "M"),
  slack: svgIcon("#4a154b", "S"),
  teams: svgIcon("#5059c9", "T"),
  globe: svgIcon("#0ea5e9", "W")
};

export function installMockBridge(mode) {
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("comms-mock") : null;
  const listeners = new Map();
  const on = (event) => (callback) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => listeners.get(event)?.delete(callback);
  };
  const emit = (event, payload) => {
    for (const callback of listeners.get(event) ?? []) setTimeout(() => callback(payload), 0);
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const service = (id, name, url, extra = {}) => ({
    id,
    name,
    url,
    iconKey: id in icons ? id : "globe",
    iconSource: icons[id] ?? icons.globe,
    isEnabled: true,
    isBuiltIn: ["gmail", "discord", "messenger", "slack", "teams"].includes(id),
    keepAliveInBackground: false,
    zoomFactor: 1,
    notificationSettings: { desktopEnabled: true, badgeEnabled: true, captureWebNotifications: true },
    ...extra
  });

  const state = {
    services: [
      service("gmail", "Gmail", "https://mail.google.com/", { keepAliveInBackground: true }),
      service("discord", "Discord", "https://discord.com/app"),
      service("messenger", "Messenger", "https://www.messenger.com/", { isEnabled: false }),
      service("slack", "Slack", "https://app.slack.com/client"),
      service("teams", "Microsoft Teams", "https://teams.microsoft.com/"),
      service("notes", "Team wiki", "http://wiki.local.test/")
    ],
    ui: {
      activeServiceId: "gmail",
      notificationsEnabled: true,
      memorySaverEnabled: true,
      memorySaverTimeoutMinutes: 10,
      sidebarCollapsed: false,
      windowMode: mode === "full" ? "full" : "dock",
      dockCorner: "bottom-left",
      dockHeight: 420,
      dockExpanded: true,
      bubbleSize: { width: 860, height: 660 },
      closeToTray: false,
      launchAtLogin: false,
      startMinimized: false,
      askWhereToSaveDownloads: false
    },
    limits: { zoom: { min: 0.5, max: 2, step: 0.1 }, dockHeight: { min: 280, max: 720 }, memorySaverTimeoutOptions: [5, 10, 15, 30, 60] },
    capabilities: { dockModeSupported: true },
    iconLibrary: Object.entries(icons).map(([key, iconSource]) => ({ key, label: key === "globe" ? "Generic Web App" : key[0].toUpperCase() + key.slice(1), iconSource }))
  };

  const runtime = {
    services: {
      gmail: { status: "active", protectionReason: "active", webContentsId: 11, canGoBack: true, canGoForward: false },
      discord: { status: "idle", protectionReason: null, webContentsId: 12, canGoBack: false, canGoForward: false },
      slack: { status: "sleeping", protectionReason: null, webContentsId: null },
      teams: { status: "unloaded", protectionReason: null, webContentsId: null },
      notes: { status: "error", error: "net::ERR_NAME_NOT_RESOLVED", webContentsId: null, retryAt: Date.now() + 30000 },
      messenger: { status: "disabled", webContentsId: null }
    },
    badgeCounts: { gmail: 4, discord: 0 },
    unseenNotificationCounts: { discord: 2, slack: 1 }
  };

  // Like main (M1): one state broadcast per tick, sent after the invoke reply, skipped when unchanged.
  let lastBroadcast = JSON.stringify(state);
  let broadcastPending = false;
  const broadcastState = () => {
    if (broadcastPending) return;
    broadcastPending = true;
    setTimeout(() => {
      broadcastPending = false;
      const snapshot = JSON.stringify(state);
      if (snapshot === lastBroadcast) return;
      lastBroadcast = snapshot;
      emit("state", JSON.parse(snapshot));
      channel?.postMessage({ type: "state", state: JSON.parse(snapshot) });
    }, 0);
  };
  const broadcastRuntime = () => {
    emit("runtime", clone(runtime));
    channel?.postMessage({ type: "runtime", runtime });
  };
  channel?.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      Object.assign(state, clone(event.data.state));
      lastBroadcast = JSON.stringify(state);
      emit("state", clone(state));
    } else if (event.data?.type === "runtime") {
      Object.assign(runtime, clone(event.data.runtime));
      emit("runtime", clone(runtime));
    }
  });

  const mutate = async (change) => {
    change();
    broadcastState();
    return clone(state);
  };
  const setUi = (patch) => mutate(() => Object.assign(state.ui, patch));
  const select = (id) => {
    for (const [key, value] of Object.entries(runtime.services)) {
      if (value.status === "active" && key !== id) value.status = "idle";
    }
    const target = runtime.services[id] ?? (runtime.services[id] = {});
    Object.assign(target, { status: "active", webContentsId: target.webContentsId ?? Math.round(Math.random() * 1000), manuallySlept: false });
    runtime.badgeCounts[id] = 0;
    runtime.unseenNotificationCounts[id] = 0;
    broadcastRuntime();
  };
  let findRequest = 0;
  let findActive = 0;

  window.commsApp = {
    getState: async () => clone(state),
    getServiceRuntime: async () => clone(runtime),
    saveService: (payload) =>
      mutate(() => {
        const id = payload.id ?? `custom-${Date.now()}`;
        const index = state.services.findIndex((item) => item.id === id);
        const next = { ...service(id, payload.name, payload.url), ...(index >= 0 ? state.services[index] : {}), ...payload, id };
        if (index >= 0) state.services[index] = next;
        else {
          state.services.push({ ...next, isBuiltIn: false });
          state.ui.activeServiceId = id;
        }
      }),
    removeService: async (id) => {
      if (!window.confirm("Remove this app? (mock of the native confirm)")) return null;
      return mutate(() => {
        state.services = state.services.filter((item) => item.id !== id);
        if (state.ui.activeServiceId === id) state.ui.activeServiceId = state.services.find((item) => item.isEnabled)?.id ?? null;
      });
    },
    reorderServices: (ids) => mutate(() => {
      const byId = new Map(state.services.map((item) => [item.id, item]));
      state.services = ids.map((id) => byId.get(id)).filter(Boolean);
    }),
    setActiveService: (id) => {
      select(id);
      return setUi({ activeServiceId: id });
    },
    setNotificationsEnabled: (enabled) => setUi({ notificationsEnabled: Boolean(enabled) }),
    setMemorySaverEnabled: (enabled) => setUi({ memorySaverEnabled: Boolean(enabled) }),
    setSidebarCollapsed: (collapsed) => setUi({ sidebarCollapsed: Boolean(collapsed) }),
    setWindowMode: (nextMode) => setUi({ windowMode: nextMode }),
    setDockCorner: (corner) => setUi({ dockCorner: corner }),
    setDockHeight: (height) => setUi({ dockHeight: Math.min(720, Math.max(280, Number(height) || 420)) }),
    setBubbleSize: (size) => setUi({ bubbleSize: size }),
    setDockExpanded: (expanded) => setUi({ dockExpanded: Boolean(expanded) }),
    openDockFromTrigger: () => setUi({ windowMode: "dock", dockExpanded: true }),
    setAppSettings: (partial) => setUi(partial),
    setServiceZoom: (id, zoomFactor) => mutate(() => {
      const target = state.services.find((item) => item.id === id);
      if (target) target.zoomFactor = zoomFactor;
    }),
    setServiceViewport: () => {},
    refreshActiveWebview: async () => true,
    navigateActive: async () => true,
    uploadIcon: async () => icons.globe,
    checkForUpdates: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { status: "up-to-date", currentVersion: "1.3.0", latestVersion: "1.3.0" };
    },
    openUpdateDownload: async () => false,
    notifyServiceEvent: async () => state.ui.notificationsEnabled,
    markNotificationsSeen: async () => clone(state),
    clearNotificationHistory: async () => clone(state),
    sleepService: async (id) => {
      Object.assign(runtime.services[id] ?? {}, { status: "sleeping", webContentsId: null, manuallySlept: true });
      broadcastRuntime();
      return true;
    },
    getServiceMetrics: async () => {
      const services = {};
      let total = 180000;
      for (const [id, value] of Object.entries(runtime.services)) {
        if (!value.webContentsId) continue;
        const memoryKB = 150000 + Math.round(Math.random() * 120000);
        total += memoryKB;
        services[id] = { memoryKB, cpuPercent: Math.random() * 4, processCount: 1, shared: id === "discord" };
      }
      return { sampledAt: Date.now(), totalMemoryKB: total, shellMemoryKB: 180000, services };
    },
    // Bridge semantics: findNext true steps through matches, false starts a new search.
    findInPage: async (text, { forward = true, findNext = false } = {}) => {
      findRequest += 1;
      const requestId = findRequest;
      const matches = text.length > 6 ? 0 : 10 - text.length;
      findActive = !matches ? 0 : !findNext ? 1 : ((findActive - 1 + (forward ? 1 : -1) + matches) % matches) + 1;
      setTimeout(() => emit("find", { requestId, activeMatchOrdinal: findActive, matches, finalUpdate: true }), 50);
      return requestId;
    },
    stopFindInPage: async () => true,
    showServiceContextMenu: async () => true,
    respondToScreenShare: async () => true,
    setOverlayBadge: async () => true,
    onStateUpdated: on("state"),
    onServiceRuntimeUpdated: on("runtime"),
    onServiceViewportRequested: on("viewport"),
    onFindResult: on("find"),
    onFindRequested: on("find-requested"),
    onEditServiceRequested: on("edit"),
    onScreenShareRequest: on("share"),
    onScreenShareCancelled: on("share-cancelled"),
    onStatusMessage: on("status")
  };

  window.__commsMock = {
    state,
    runtime,
    status: (text, tone = "info") => emit("status", { text, tone }),
    editRequest: (serviceId) => emit("edit", { serviceId }),
    findRequest: () => emit("find-requested"),
    viewportRequest: () => emit("viewport"),
    shareCancelled: (requestId) => emit("share-cancelled", { requestId }),
    setStatus: (id, status) => {
      Object.assign(runtime.services[id] ?? {}, { status });
      broadcastRuntime();
    },
    unread: (id, count) => {
      runtime.badgeCounts[id] = count;
      broadcastRuntime();
    },
    shareRequest: (audioRequested = true, foreignOrigin = null) => {
      const requestId = Date.now();
      emit("share", {
        requestId,
        serviceId: "teams",
        serviceName: "Microsoft Teams",
        foreignOrigin,
        audioRequested,
        sources: [
          { id: "screen:0:0", name: "Entire screen 1", kind: "screen", thumbnailDataUrl: thumb("#1e3a8a", "Screen 1"), appIconDataUrl: null },
          { id: "screen:1:0", name: "Entire screen 2", kind: "screen", thumbnailDataUrl: thumb("#14532d", "Screen 2"), appIconDataUrl: null },
          { id: "window:1:0", name: "Quarterly report.xlsx - Excel", kind: "window", thumbnailDataUrl: thumb("#166534", "Excel"), appIconDataUrl: icons.globe },
          { id: "window:2:0", name: "Visual Studio Code", kind: "window", thumbnailDataUrl: thumb("#1f2937", "Code"), appIconDataUrl: icons.discord }
        ]
      });
      return requestId;
    }
  };
}
