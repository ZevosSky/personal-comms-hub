import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
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

const broadcastState = (state) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("state:updated", state);
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

const createWindow = async () => {
  const distEntry = path.join(__dirname, "..", "dist", "index.html");

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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("focus", () => {
    markActiveServiceSeen();
  });
  mainWindow.on("close", () => {
    flushKnownSessions().catch(() => {});
  });

  if (isDev) {
    try {
      await mainWindow.loadURL("http://localhost:5173");
      mainWindow.webContents.openDevTools({ mode: "detach" });
    } catch (error) {
      console.error("Failed to load dev server, falling back to dist build.", error);
      await mainWindow.loadFile(distEntry);
    }
  } else {
    await mainWindow.loadFile(distEntry);
  }
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

ipcMain.handle("icons:upload", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
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
  createWindow().catch((error) => {
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      console.error("Failed to recreate main window.", error);
    });
  }
});
