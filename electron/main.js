import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  shell
} from "electron";
import {
  appendNotificationHistory,
  clearNotificationHistory,
  copyIconToUserData,
  getAppState,
  removeService,
  reorderServices,
  setUiState,
  upsertService
} from "./configStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
const isDev = process.argv.includes("--dev");
const guestPreloadPath = path.join(__dirname, "guestPreload.js");
const appIcon = nativeImage.createFromDataURL(
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#0f172a'/><path d='M18 32h12M30 14v36M30 14h10M30 26h10M30 38h10M30 50h10' fill='none' stroke='#e0f2fe' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'/><circle cx='16' cy='32' r='7' fill='#e0f2fe'/><circle cx='42' cy='14' r='6' fill='#e0f2fe'/><circle cx='42' cy='26' r='6' fill='#e0f2fe'/><circle cx='42' cy='38' r='6' fill='#e0f2fe'/><circle cx='42' cy='50' r='6' fill='#e0f2fe'/></svg>"
  )}`
);

const broadcastState = (state) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("state:updated", state);
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
      webviewTag: true,
      additionalArguments: [`--guest-preload=${guestPreloadPath}`]
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.setMenuBarVisibility(false);

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

  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
});

ipcMain.handle("app-state:get", () => getAppState());

ipcMain.handle("services:save", (_event, service) => {
  const state = upsertService(service);
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
  const state = setUiState({ activeServiceId: serviceId });
  broadcastState(state);
  return state;
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

ipcMain.handle("paths:get-guest-preload", () => guestPreloadPath.replace(/\\/g, "/"));

app.whenReady().then(() => {
  createWindow().catch((error) => {
    console.error("Failed to create main window.", error);
    app.quit();
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
