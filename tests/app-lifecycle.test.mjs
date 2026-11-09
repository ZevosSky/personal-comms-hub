import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APP_USER_MODEL_ID,
  DEV_PROFILE_NAME,
  LOCAL_PROFILE_NAME,
  START_HIDDEN_ARG,
  countUnread,
  isDevRun,
  loginItemSettingsFor,
  resolveDevUserDataPath,
  shouldStartHidden,
  trayMenuModel,
  trayToolTip
} from "../electron/appLifecycle.js";
import { migrateConfig, toPersistedConfig } from "../electron/appStateModel.js";
import { createConfigStore } from "../electron/configStoreCore.js";
import { MAIN_WINDOW_MIN_SIZE } from "../electron/limits.js";
import { normalizeWindowState, restoreWindowBounds } from "../electron/windowGeometry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("--dev is honoured only in unpackaged runs", () => {
  assert.equal(isDevRun({ isPackaged: false, argv: ["electron", ".", "--dev"] }), true);
  assert.equal(isDevRun({ isPackaged: true, argv: ["Comms Hub.exe", "--dev"] }), false);
  assert.equal(isDevRun({ isPackaged: false, argv: ["electron", "."] }), false);
});

test("unpackaged runs move to their own profile unless userData was already overridden", () => {
  const appData = path.join(path.sep, "Users", "me", "AppData", "Roaming");
  const defaults = { isPackaged: false, isDev: true, appData, appName: "Comms Hub", userData: path.join(appData, "Comms Hub") };
  assert.equal(resolveDevUserDataPath(defaults), path.join(appData, DEV_PROFILE_NAME));
  assert.equal(resolveDevUserDataPath({ ...defaults, isPackaged: true }), null, "the installed app keeps its profile");
  assert.equal(
    resolveDevUserDataPath({ ...defaults, isDev: false }),
    path.join(appData, LOCAL_PROFILE_NAME),
    "npm start never opens the installed app's profile"
  );
  assert.notEqual(LOCAL_PROFILE_NAME, "Comms Hub");
  assert.equal(
    resolveDevUserDataPath({ ...defaults, userData: path.join(path.sep, "tmp", "fixture-profile") }),
    null,
    "a test or --user-data-dir override is never replaced"
  );
  assert.equal(resolveDevUserDataPath({ ...defaults, userData: "" }), null);
});

test("hidden starts: login item argument, start-minimized setting or macOS login launch", () => {
  assert.equal(shouldStartHidden({ argv: ["Comms Hub.exe"] }), false);
  assert.equal(shouldStartHidden({ argv: ["Comms Hub.exe", START_HIDDEN_ARG] }), true);
  assert.equal(shouldStartHidden({ argv: [], startMinimized: true }), true);
  assert.equal(shouldStartHidden({ argv: [], wasOpenedAtLogin: true }), true);
  assert.equal(shouldStartHidden({ argv: [], startMinimized: "yes" }), false);
});

test("login items are registered only for packaged Windows/macOS builds", () => {
  const execPath = "C:\\Program Files\\Comms Hub\\Comms Hub.exe";
  assert.deepEqual(loginItemSettingsFor({ platform: "win32", isPackaged: true, execPath, openAtLogin: true }), {
    openAtLogin: true,
    path: execPath,
    args: [START_HIDDEN_ARG],
    name: APP_USER_MODEL_ID
  });
  assert.equal(loginItemSettingsFor({ platform: "win32", isPackaged: true, execPath, openAtLogin: false }).openAtLogin, false);
  assert.deepEqual(loginItemSettingsFor({ platform: "darwin", isPackaged: true, execPath, openAtLogin: true }), { openAtLogin: true });
  assert.equal(loginItemSettingsFor({ platform: "win32", isPackaged: false, execPath, openAtLogin: true }), null, "never register bare Electron");
  assert.equal(loginItemSettingsFor({ platform: "linux", isPackaged: true, execPath, openAtLogin: true }), null);
});

test("the AppUserModelId matches the installer's appId", () => {
  assert.equal(APP_USER_MODEL_ID, packageJson.build.appId);
});

test("tray unread total counts enabled services like the rail badge", () => {
  const services = [
    { id: "a", isEnabled: true },
    { id: "b", isEnabled: true },
    { id: "c", isEnabled: false },
    { id: "d", isEnabled: true }
  ];
  assert.equal(countUnread({ services, badgeCounts: {}, unseenNotificationCounts: {} }), 0);
  assert.equal(
    countUnread({
      services,
      badgeCounts: { a: 5, b: 0, c: 9 },
      unseenNotificationCounts: { a: 2, b: 3, c: 4, d: Number.NaN }
    }),
    8,
    "a title count wins over unseen notifications; unknown counts fall back to unseen; hidden apps are ignored"
  );
  assert.equal(countUnread({ services, badgeCounts: { a: -2, b: "7" } }), 7);
  assert.equal(countUnread(), 0);
  assert.equal(trayToolTip(0), "Comms Hub");
  assert.equal(trayToolTip(3), "Comms Hub - 3 unread");
  assert.equal(trayToolTip(12000), "Comms Hub - 999+ unread");
});

test("tray menu follows the current window mode", () => {
  const actions = (model) => model.map((item) => item.action ?? item.type ?? "disabled");
  assert.deepEqual(actions(trayMenuModel({ windowMode: "full", dockModeSupported: true })), ["open-full", "enter-dock", "separator", "quit"]);
  assert.deepEqual(actions(trayMenuModel({ windowMode: "dock", dockModeSupported: true })), ["open-full", "show-dock", "separator", "quit"]);
  const linux = trayMenuModel({ windowMode: "full", dockModeSupported: false });
  assert.deepEqual(actions(linux), ["open-full", "disabled", "separator", "quit"]);
  assert.equal(linux[1].enabled, false);
  assert.notEqual(
    JSON.stringify(trayMenuModel({ windowMode: "full", dockModeSupported: true })),
    JSON.stringify(trayMenuModel({ windowMode: "dock", dockModeSupported: true })),
    "a mode change changes the menu key, so the menu is rebuilt"
  );
});

test("saved window state is validated", () => {
  assert.equal(normalizeWindowState(null), null);
  assert.equal(normalizeWindowState({ x: 0, y: 0, width: 0, height: 600 }), null);
  assert.equal(normalizeWindowState({ x: "1", y: 0, width: 900, height: 600 }), null);
  assert.equal(normalizeWindowState({ x: 1e7, y: 0, width: 900, height: 600 }), null);
  assert.deepEqual(normalizeWindowState({ x: 10.4, y: -5.6, width: 300, height: 99999, isMaximized: 1 }), {
    x: 10,
    y: -6,
    width: MAIN_WINDOW_MIN_SIZE.width,
    height: 20000,
    isMaximized: false
  });
});

test("restored bounds stay on a current display (D18)", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = { x: 1920, y: 0, width: 2560, height: 1400 };
  const workAreas = [primary, right];
  const place = (saved, areas = workAreas, primaryWorkArea = primary) =>
    restoreWindowBounds({ saved, workAreas: areas, primaryWorkArea });

  assert.deepEqual(place(null), { x: 240, y: 40, width: 1440, height: 960, isMaximized: false }, "default size centred");
  assert.deepEqual(
    place({ x: 2100, y: 100, width: 1200, height: 800, isMaximized: true }),
    { x: 2100, y: 100, width: 1200, height: 800, isMaximized: true },
    "kept on the second monitor"
  );
  assert.deepEqual(
    place({ x: -300, y: 100, width: 1000, height: 700 }),
    { x: 0, y: 100, width: 1000, height: 700, isMaximized: false },
    "a mostly visible window is pulled fully on screen"
  );
  assert.deepEqual(
    place({ x: 2100, y: 100, width: 1200, height: 800, isMaximized: true }, [primary]),
    { x: 240, y: 40, width: 1440, height: 960, isMaximized: true },
    "a disconnected monitor falls back to the primary display"
  );
  assert.deepEqual(
    place({ x: -5000, y: -5000, width: 1000, height: 700 }),
    { x: 240, y: 40, width: 1440, height: 960, isMaximized: false },
    "an off-screen window is re-centred"
  );
  assert.deepEqual(
    place({ x: 100, y: 50, width: 3000, height: 2000 }),
    { x: 0, y: 0, width: 1920, height: 1040, isMaximized: false },
    "a too-large window shrinks to the work area"
  );

  const laptop = { x: 0, y: 0, width: 1280, height: 688 };
  assert.deepEqual(place(null, [laptop], laptop), { x: 0, y: 0, width: 1280, height: 688, isMaximized: false }, "1080p at 150% fits");
  const tiny = { x: 0, y: 0, width: 700, height: 500 };
  assert.deepEqual(
    place(null, [tiny], tiny),
    { x: 0, y: 0, width: MAIN_WINDOW_MIN_SIZE.width, height: MAIN_WINDOW_MIN_SIZE.height, isMaximized: false },
    "never below the minimum size, anchored at the work area origin"
  );
  assert.deepEqual(
    restoreWindowBounds({ saved: null, workAreas: [], primaryWorkArea: null }),
    { width: 1440, height: 960, isMaximized: false },
    "no display information lets the OS place the window"
  );
});

test("main window state is persisted outside the renderer snapshot", () => {
  const saves = [];
  const timers = [];
  const store = createConfigStore({
    backing: { load: () => ({ status: "missing", data: null }), save: (data) => saves.push(structuredClone(data)) },
    platform: "win32",
    setTimeoutFn: (callback) => timers.push(callback),
    clearTimeoutFn: () => {}
  });
  const snapshot = store.getAppState();
  timers.splice(0).forEach((callback) => callback());
  saves.length = 0;
  assert.equal(store.getMainWindowState(), null);
  assert.equal("mainWindowState" in snapshot, false);

  assert.equal(store.setMainWindowState({ x: 10, y: 20, width: 1000, height: 700, isMaximized: true }), true);
  assert.equal(store.getAppState(), snapshot, "renderers are not re-sent state for a window move");
  assert.equal(store.setMainWindowState({ x: 10, y: 20, width: 1000, height: 700, isMaximized: true }), false, "unchanged");
  assert.equal(store.setMainWindowState({ x: Number.NaN }), false, "invalid");
  timers.splice(0).forEach((callback) => callback());
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].mainWindowState, { x: 10, y: 20, width: 1000, height: 700, isMaximized: true });

  const reloaded = migrateConfig(JSON.parse(JSON.stringify(saves[0])));
  assert.equal(reloaded.changed, false);
  assert.deepEqual(reloaded.config.mainWindowState, saves[0].mainWindowState);
  assert.deepEqual(toPersistedConfig(reloaded.config), saves[0]);
  assert.equal(migrateConfig({ mainWindowState: "garbage" }).config.mainWindowState, null, "bad values never reject the file");
  assert.equal("mainWindowState" in toPersistedConfig(migrateConfig({}).config), false);
});
