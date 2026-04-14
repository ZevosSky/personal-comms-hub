import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  screen,
  session,
  shell
} from "electron";
import {
  appendNotificationHistory,
  clearNotificationHistory,
  copyIconToUserData,
  getAppState,
  markServiceNotificationsSeen,
  removeService,
  reorderServices,
  setUiState,
  upsertService
} from "./configStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);

let mainWindow = null;
let dockWindow = null;
let bubbleWindow = null;
const isDev = process.argv.includes("--dev");
const guestPreloadPath = path.join(__dirname, "guestPreload.js");
const updatesRepository =
  packageJson.repository?.url?.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/)?.[1] ?? null;
const appIcon = nativeImage.createFromDataURL(
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#0f172a'/><g fill='none' stroke='#e0f2fe' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'><line x1='20' y1='32' x2='30' y2='32'/><line x1='30' y1='12' x2='30' y2='52'/><line x1='30' y1='12' x2='38' y2='12'/><line x1='30' y1='25.33' x2='38' y2='25.33'/><line x1='30' y1='38.67' x2='38' y2='38.67'/><line x1='30' y1='52' x2='38' y2='52'/></g><circle cx='14' cy='32' r='6' fill='#e0f2fe'/><circle cx='44' cy='12' r='5.5' fill='#e0f2fe'/><circle cx='44' cy='25.33' r='5.5' fill='#e0f2fe'/><circle cx='44' cy='38.67' r='5.5' fill='#e0f2fe'/><circle cx='44' cy='52' r='5.5' fill='#e0f2fe'/></svg>"
  )}`
);
const allowedPermissions = new Set([
  "notifications",
  "fullscreen",
  "media",
  "display-capture",
  "clipboard-sanitized-write"
]);
const configuredSessionPartitions = new Set();
const embeddedAuthHosts = new Set([
  "accounts.google.com",
  "app.slack.com",
  "slack.com",
  "login.microsoftonline.com",
  "login.live.com",
  "discord.com",
  "www.messenger.com",
  "messenger.com",
  "teams.microsoft.com"
]);
const dockWindowSize = {
  dock: { width: 72, height: 420 },
  bubble: { width: 980, height: 820 },
  crossMargin: 18
};

const isSafeHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const normalizeVersion = (version) => String(version || "").replace(/^v/i, "").split("-")[0];

const compareVersions = (left, right) => {
  const leftParts = normalizeVersion(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const max = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < max; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a > b) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
  }

  return 0;
};

const getPlatformAsset = (assets = []) => {
  if (process.platform === "win32") {
    return assets.find(
      (asset) =>
        asset.name.endsWith(".exe") &&
        !asset.name.endsWith(".blockmap") &&
        !asset.name.toLowerCase().includes("uninstaller")
    );
  }

  if (process.platform === "linux") {
    return assets.find((asset) => asset.name.endsWith(".AppImage"));
  }

  return null;
};

const checkForUpdates = async () => {
  const currentVersion = app.getVersion();

  if (!updatesRepository) {
    return {
      status: "unconfigured",
      currentVersion,
      platform: process.platform
    };
  }

  const response = await fetch(`https://api.github.com/repos/${updatesRepository}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Comms-Hub-Updater"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed with status ${response.status}`);
  }

  const release = await response.json();
  const latestVersion = normalizeVersion(release.tag_name || release.name || currentVersion);
  const asset = getPlatformAsset(release.assets);

  return {
    status: compareVersions(latestVersion, currentVersion) > 0 ? "update-available" : "up-to-date",
    currentVersion,
    latestVersion,
    platform: process.platform,
    releaseName: release.name || release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    assetName: asset?.name ?? null,
    assetUrl: asset?.browser_download_url ?? null
  };
};

const shouldOpenInsideGuest = (currentUrl, targetUrl) => {
  if (!isSafeHttpUrl(targetUrl)) {
    return false;
  }

  try {
    const current = currentUrl ? new URL(currentUrl) : null;
    const target = new URL(targetUrl);

    if (current && current.origin === target.origin) {
      return true;
    }

    return embeddedAuthHosts.has(target.hostname);
  } catch {
    return false;
  }
};

const configureSessionPermissions = (targetSession) => {
  if (!targetSession) {
    return;
  }

  const key = targetSession === session.defaultSession ? "default" : targetSession.getStoragePath?.() || Math.random().toString(36);
  if (configuredSessionPartitions.has(key)) {
    return;
  }

  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return allowedPermissions.has(permission) && isSafeHttpUrl(requestingOrigin);
  });

  targetSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(allowedPermissions.has(permission) && isSafeHttpUrl(details.requestingUrl));
    }
  );

  targetSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isSafeHttpUrl(request.securityOrigin)) {
        callback({});
        return;
      }

      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false
        });
        const preferredSource =
          sources.find((source) => source.id.startsWith("screen:")) ?? sources[0];

        if (!preferredSource && request.videoRequested) {
          callback({});
          return;
        }

        callback({
          video: request.videoRequested ? preferredSource : undefined,
          audio:
            request.audioRequested && process.platform !== "darwin"
              ? "loopback"
              : undefined
        });
      } catch {
        callback({});
      }
    },
    {
      useSystemPicker: true
    }
  );

  configuredSessionPartitions.add(key);
};

const configureKnownSessions = () => {
  configureSessionPermissions(session.defaultSession);
  for (const service of getAppState().services) {
    if (service.sessionPartition) {
      configureSessionPermissions(session.fromPartition(service.sessionPartition));
    }
  }
};

const getKnownServiceSessions = () =>
  getAppState().services
    .map((service) => service.sessionPartition)
    .filter(Boolean)
    .map((partition) => session.fromPartition(partition));

const flushKnownSessions = async () => {
  const uniqueSessions = new Map();

  for (const targetSession of getKnownServiceSessions()) {
    const key = targetSession.getStoragePath?.() || Math.random().toString(36);
    if (!uniqueSessions.has(key)) {
      uniqueSessions.set(key, targetSession);
    }
  }

  await Promise.allSettled(
    [...uniqueSessions.values()].flatMap((targetSession) => [
      targetSession.cookies.flushStore(),
      targetSession.flushStorageData()
    ])
  );
};

const getAllAppWindows = () =>
  [mainWindow, dockWindow, bubbleWindow].filter(
    (windowInstance) => windowInstance && !windowInstance.isDestroyed()
  );

const broadcastState = (state) => {
  for (const windowInstance of getAllAppWindows()) {
    windowInstance.webContents.send("state:updated", state);
  }
};

const markActiveServiceSeen = () => {
  const state = getAppState();
  if (!state.ui.activeServiceId) {
    return state;
  }

  const nextState = markServiceNotificationsSeen(state.ui.activeServiceId);
  broadcastState(nextState);
  return nextState;
};

const getDockBounds = (ui = getAppState().ui) => {
  const { dock: target, crossMargin } = dockWindowSize;
  const workArea = screen.getPrimaryDisplay().workArea;

  let x = workArea.x;
  let y = workArea.y + workArea.height - target.height - crossMargin;

  switch (ui.dockCorner) {
    case "top-left":
      x = workArea.x;
      y = workArea.y + crossMargin;
      break;
    case "top-right":
      x = workArea.x + workArea.width - target.width;
      y = workArea.y + crossMargin;
      break;
    case "bottom-right":
      x = workArea.x + workArea.width - target.width;
      y = workArea.y + workArea.height - target.height - crossMargin;
      break;
    case "bottom-left":
    default:
      x = workArea.x;
      y = workArea.y + workArea.height - target.height - crossMargin;
      break;
  }

  return {
    ...target,
    x,
    y
  };
};

const getBubbleBounds = (ui = getAppState().ui) => {
  const { bubble, crossMargin } = dockWindowSize;
  const workArea = screen.getPrimaryDisplay().workArea;
  const dockBounds = getDockBounds(ui);
  const rightAnchored = ui.dockCorner === "top-right" || ui.dockCorner === "bottom-right";

  let x = rightAnchored ? dockBounds.x - bubble.width : dockBounds.x + dockBounds.width;
  let y = dockBounds.y;

  if (ui.dockCorner === "top-left" || ui.dockCorner === "top-right") {
    y = workArea.y + crossMargin;
  } else {
    y = workArea.y + workArea.height - bubble.height - crossMargin;
  }

  return {
    ...bubble,
    x,
    y
  };
};

const applyDockBounds = () => {
  if (!dockWindow || dockWindow.isDestroyed()) {
    return;
  }

  const bounds = getDockBounds();
  dockWindow.setBounds(bounds, true);
};

const applyBubbleBounds = () => {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    return;
  }

  const bounds = getBubbleBounds();
  bubbleWindow.setBounds(bounds, true);
};

const configureFloatingUtilityWindow = (windowInstance) => {
  if (!windowInstance || windowInstance.isDestroyed()) {
    return;
  }

  windowInstance.setAlwaysOnTop(true, "floating");
  windowInstance.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
};

const restoreDockWindows = () => {
  const state = getAppState();
  if (state.ui.windowMode !== "dock") {
    return;
  }

  if (dockWindow && !dockWindow.isDestroyed()) {
    applyDockBounds();
    configureFloatingUtilityWindow(dockWindow);
    if (!dockWindow.isVisible()) {
      dockWindow.showInactive();
    }
  }

  if (state.ui.dockExpanded && bubbleWindow && !bubbleWindow.isDestroyed()) {
    applyBubbleBounds();
    configureFloatingUtilityWindow(bubbleWindow);
    if (!bubbleWindow.isVisible()) {
      bubbleWindow.showInactive();
    }
  }
};

const attachSharedWindowBehavior = (windowInstance) => {
  windowInstance.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  windowInstance.setMenuBarVisibility(false);
  windowInstance.on("focus", () => {
    markActiveServiceSeen();
  });
  windowInstance.on("close", () => {
    flushKnownSessions().catch(() => {});
  });
};

const loadRendererIntoWindow = async (windowInstance, mode = "full") => {
  const distEntry = path.join(__dirname, "..", "dist", "index.html");

  if (isDev) {
    try {
      await windowInstance.loadURL(`http://localhost:5173/?mode=${mode}`);
      if (mode === "full") {
        windowInstance.webContents.openDevTools({ mode: "detach" });
      }
    } catch (error) {
      console.error("Failed to load dev server, falling back to dist build.", error);
      await windowInstance.loadFile(distEntry, { query: { mode } });
    }
  } else {
    await windowInstance.loadFile(distEntry, { query: { mode } });
  }
};

const createMainWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    title: "Comms Hub",
    icon: appIcon,
    backgroundColor: "#08111d",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "win32" ? "hidden" : "default",
    titleBarOverlay:
      process.platform === "win32"
        ? {
            color: "#08111d",
            symbolColor: "#e5eefc",
            height: 40
          }
        : false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      additionalArguments: [`--guest-preload=${guestPreloadPath}`]
    }
  });

  attachSharedWindowBehavior(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await loadRendererIntoWindow(mainWindow, "full");
};

const createDockWindow = async () => {
  const bounds = getDockBounds();

  dockWindow = new BrowserWindow({
    ...bounds,
    minWidth: dockWindowSize.dock.width,
    minHeight: 420,
    maxWidth: dockWindowSize.dock.width,
    maxHeight: dockWindowSize.dock.height,
    title: "Comms Hub Dock",
    icon: appIcon,
    frame: false,
    resizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#08111d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      additionalArguments: [`--guest-preload=${guestPreloadPath}`]
    }
  });

  attachSharedWindowBehavior(dockWindow);
  configureFloatingUtilityWindow(dockWindow);
  dockWindow.on("closed", () => {
    dockWindow = null;
  });
  await loadRendererIntoWindow(dockWindow, "dock");
};

const createBubbleWindow = async () => {
  const bounds = getBubbleBounds();

  bubbleWindow = new BrowserWindow({
    ...bounds,
    minWidth: 560,
    minHeight: 520,
    maxWidth: dockWindowSize.bubble.width,
    maxHeight: dockWindowSize.bubble.height,
    title: "Comms Hub Bubble",
    icon: appIcon,
    frame: false,
    resizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#08111d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      additionalArguments: [`--guest-preload=${guestPreloadPath}`]
    }
  });

  attachSharedWindowBehavior(bubbleWindow);
  configureFloatingUtilityWindow(bubbleWindow);
  bubbleWindow.on("closed", () => {
    bubbleWindow = null;
  });
  await loadRendererIntoWindow(bubbleWindow, "bubble");
};

const syncWindowMode = async () => {
  const { windowMode } = getAppState().ui;

  if (!mainWindow || mainWindow.isDestroyed()) {
    await createMainWindow();
  }

  if (windowMode === "dock") {
    if (!dockWindow || dockWindow.isDestroyed()) {
      await createDockWindow();
    } else {
      applyDockBounds();
    }

    if (getAppState().ui.dockExpanded) {
      if (!bubbleWindow || bubbleWindow.isDestroyed()) {
        await createBubbleWindow();
      } else {
        applyBubbleBounds();
        bubbleWindow.show();
      }
    } else if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.hide();
    }

    mainWindow.hide();
    dockWindow.show();
    dockWindow.focus();
    return;
  }

  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.hide();
  }
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.hide();
  }

  mainWindow.show();
  mainWindow.focus();
};

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") {
    return;
  }

  contents.on("will-navigate", (event, navigationUrl) => {
    if (!isSafeHttpUrl(navigationUrl)) {
      event.preventDefault();
      shell.openExternal(navigationUrl);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenInsideGuest(contents.getURL(), url)) {
      contents.loadURL(url).catch(() => {
        shell.openExternal(url);
      });
      return { action: "deny" };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });
});

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "window") {
    return;
  }

  contents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isSafeHttpUrl(params.src)) {
      event.preventDefault();
      return;
    }

    delete webPreferences.preloadURL;
    webPreferences.preload = guestPreloadPath;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.enableBlinkFeatures = "";
    webPreferences.disableBlinkFeatures = "";
  });
});

ipcMain.handle("app-state:get", () => getAppState());

ipcMain.handle("services:save", (_event, service) => {
  const state = upsertService(service);
  configureKnownSessions();
  broadcastState(state);
  return state;
});

ipcMain.handle("services:remove", (_event, serviceId) => {
  const state = removeService(serviceId);
  broadcastState(state);
  return state;
});

ipcMain.handle("services:reorder", (_event, serviceIds) => {
  const state = reorderServices(serviceIds);
  broadcastState(state);
  return state;
});

ipcMain.handle("ui:set-active-service", (_event, serviceId) => {
  setUiState({ activeServiceId: serviceId });
  const seenState = markServiceNotificationsSeen(serviceId);
  broadcastState(seenState);
  return seenState;
});

ipcMain.handle("ui:set-notifications", (_event, enabled) => {
  const state = setUiState({ notificationsEnabled: Boolean(enabled) });
  broadcastState(state);
  return state;
});

ipcMain.handle("ui:set-memory-saver", (_event, enabled) => {
  const state = setUiState({ memorySaverEnabled: Boolean(enabled) });
  broadcastState(state);
  return state;
});

ipcMain.handle("ui:set-sidebar-collapsed", (_event, collapsed) => {
  const state = setUiState({ sidebarCollapsed: Boolean(collapsed) });
  broadcastState(state);
  return state;
});

ipcMain.handle("ui:set-window-mode", async (_event, mode) => {
  const nextMode = mode === "dock" ? "dock" : "full";
  const state = setUiState({ windowMode: nextMode });
  broadcastState(state);
  await syncWindowMode();
  return getAppState();
});

ipcMain.handle("ui:set-dock-corner", (_event, corner) => {
  const supportedCorner = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);
  const state = setUiState({
    dockCorner: supportedCorner.has(corner) ? corner : "bottom-left"
  });
  applyDockBounds();
  applyBubbleBounds();
  broadcastState(state);
  return state;
});

ipcMain.handle("ui:set-dock-expanded", async (_event, expanded) => {
  const state = setUiState({ dockExpanded: Boolean(expanded) });
  if (state.ui.windowMode === "dock") {
    if (expanded) {
      if (!bubbleWindow || bubbleWindow.isDestroyed()) {
        await createBubbleWindow();
      } else {
        applyBubbleBounds();
        bubbleWindow.show();
        bubbleWindow.focus();
      }
    } else if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.hide();
    }
  }
  broadcastState(state);
  return state;
});

ipcMain.handle("icons:upload", async (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? dockWindow ?? undefined;
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "Choose an app icon",
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return copyIconToUserData(result.filePaths[0]);
});

ipcMain.handle("shell:open-external", (_event, url) => shell.openExternal(url));

ipcMain.handle("updates:check", async () => {
  try {
    return await checkForUpdates();
  } catch (error) {
    return {
      status: "error",
      currentVersion: app.getVersion(),
      platform: process.platform,
      error: error instanceof Error ? error.message : "Unknown update error"
    };
  }
});

ipcMain.handle("updates:open", async () => {
  const updateInfo = await checkForUpdates();
  const targetUrl = updateInfo.assetUrl || updateInfo.releaseUrl;

  if (!targetUrl) {
    return false;
  }

  await shell.openExternal(targetUrl);
  return true;
});

const recordNotificationEvent = (payload) => {
  const entry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...payload
  };
  const state = appendNotificationHistory(entry);
  broadcastState(state);
  return state;
};

ipcMain.handle("notifications:service-event", (_event, payload) => {
  const state = getAppState();
  const service = state.services.find((item) => item.id === payload.serviceId);

  recordNotificationEvent({
    serviceId: payload.serviceId,
    serviceName: payload.serviceName || service?.name || "Comms App",
    source: payload.source || "activity",
    title: payload.title || payload.serviceName || service?.name || "Comms App",
    body: payload.message || payload.body || "New activity detected"
  });

  if (
    !state.ui.notificationsEnabled ||
    !service?.notificationSettings?.desktopEnabled ||
    !Notification.isSupported()
  ) {
    return false;
  }

  new Notification({
    title: payload.title || payload.serviceName || service?.name || "Comms App",
    body: payload.message || payload.body || "New activity detected"
  }).show();

  return true;
});

ipcMain.handle("notifications:clear-history", () => {
  const state = clearNotificationHistory();
  broadcastState(state);
  return state;
});

ipcMain.handle("notifications:mark-seen", (_event, serviceId) => {
  const state = markServiceNotificationsSeen(serviceId);
  broadcastState(state);
  return state;
});

ipcMain.handle("paths:get-guest-preload", () => guestPreloadPath.replace(/\\/g, "/"));

app.whenReady().then(() => {
  configureKnownSessions();
  setInterval(() => {
    flushKnownSessions().catch(() => {});
  }, 30000);
  screen.on("display-metrics-changed", () => {
    restoreDockWindows();
  });
  screen.on("display-added", () => {
    restoreDockWindows();
  });
  screen.on("display-removed", () => {
    restoreDockWindows();
  });
  syncWindowMode().catch((error) => {
    console.error("Failed to create main window.", error);
    app.quit();
  });
});

app.on("before-quit", (event) => {
  event.preventDefault();
  flushKnownSessions()
    .catch(() => {})
    .finally(() => {
      app.exit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  restoreDockWindows();
  if (BrowserWindow.getAllWindows().length === 0) {
    syncWindowMode().catch((error) => {
      console.error("Failed to recreate main window.", error);
    });
  }
});
