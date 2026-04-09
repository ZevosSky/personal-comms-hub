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
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#0f172a'/><g fill='none' stroke='#e0f2fe' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'><line x1='20' y1='32' x2='30' y2='32'/><line x1='30' y1='12' x2='30' y2='52'/><line x1='30' y1='12' x2='38' y2='12'/><line x1='30' y1='25.33' x2='38' y2='25.33'/><line x1='30' y1='38.67' x2='38' y2='38.67'/><line x1='30' y1='52' x2='38' y2='52'/></g><circle cx='14' cy='32' r='6' fill='#e0f2fe'/><circle cx='44' cy='12' r='5.5' fill='#e0f2fe'/><circle cx='44' cy='25.33' r='5.5' fill='#e0f2fe'/><circle cx='44' cy='38.67' r='5.5' fill='#e0f2fe'/><circle cx='44' cy='52' r='5.5' fill='#e0f2fe'/></svg>"
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
