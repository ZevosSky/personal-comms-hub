import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_VERSION,
  builtInServices,
  buildAppState,
  migrateConfig,
  normalizePermissionDecisions,
  normalizeService,
  normalizeUi,
  sanitizeAppSettings,
  toPersistedConfig,
  toPersistedService,
  validateConfigShape
} from "../electron/appStateModel.js";
import { createConfigStore } from "../electron/configStoreCore.js";
import {
  clampDockHeight,
  clampZoomFactor,
  isHttpUrl,
  normalizeDockCorner,
  normalizeMemorySaverTimeout,
  rendererLimits
} from "../electron/limits.js";

const teams = builtInServices.find((service) => service.id === "teams");

function memoryBacking(initial, { status = initial === undefined ? "missing" : "ok" } = {}) {
  const backing = {
    data: initial ?? null,
    loads: 0,
    saves: [],
    failSaves: 0,
    load() {
      backing.loads += 1;
      return { status, data: structuredClone(backing.data), backupPath: "backup.json", error: new Error(status) };
    },
    save(data) {
      if (backing.failSaves > 0) {
        backing.failSaves -= 1;
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      }
      backing.saves.push(structuredClone(data));
      backing.data = structuredClone(data);
    }
  };
  return backing;
}

function fakeTimers() {
  const timers = new Map();
  let sequence = 0;
  return {
    setTimeoutFn: (fn, delay) => { sequence += 1; timers.set(sequence, { fn, delay }); return sequence; },
    clearTimeoutFn: (id) => timers.delete(id),
    pending: () => [...timers.values()],
    runAll() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
    }
  };
}

function createStore(initial, options = {}) {
  const backing = options.backing ?? memoryBacking(initial, options);
  const timers = fakeTimers();
  const logs = [];
  let ids = 0;
  const store = createConfigStore({
    backing,
    platform: "win32",
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: (message) => logs.push(message),
    createId: () => `generated-${++ids}`
  });
  return { store, backing, timers, logs };
}

const v2Config = (overrides = {}) => ({
  configVersion: CONFIG_VERSION,
  services: [{ id: "custom", name: "Custom", url: "https://custom.example/app" }],
  ui: { activeServiceId: "custom" },
  ...overrides
});

test("shared limits clamp and validate", () => {
  assert.equal(clampZoomFactor(5), 2);
  assert.equal(clampZoomFactor(0.1), 0.5);
  assert.equal(clampZoomFactor("x"), 1);
  assert.equal(clampZoomFactor(undefined), 1);
  assert.equal(clampDockHeight(9999), 720);
  assert.equal(clampDockHeight(10), 280);
  assert.equal(clampDockHeight(null), 280);
  assert.equal(clampDockHeight("nope"), 420);
  assert.equal(normalizeDockCorner("top-right"), "top-right");
  assert.equal(normalizeDockCorner("middle"), "bottom-left");
  assert.equal(normalizeMemorySaverTimeout(30), 30);
  assert.equal(normalizeMemorySaverTimeout(7), 10);
  assert.equal(isHttpUrl("https://example.com"), true);
  assert.equal(isHttpUrl("http://127.0.0.1:3000/x"), true);
  for (const bad of ["javascript:alert(1)", "file:///C:/x", "mailto:a@b.c", "", null, "example.com"]) {
    assert.equal(isHttpUrl(bad), false, bad);
  }
  assert.deepEqual(rendererLimits, {
    zoom: { min: 0.5, max: 2, step: 0.1 },
    dockHeight: { min: 280, max: 720 },
    memorySaverTimeoutOptions: [5, 10, 15, 30, 60]
  });
});

test("built-in definitions own code-owned fields, even over stored values", () => {
  const stored = normalizeService({
    id: "teams",
    userAgent: "Stored/1.0",
    supportsBadgeDetection: false,
    sessionPartition: "persist:hijacked",
    useDefaultSession: true,
    isBuiltIn: false,
    name: "Work Teams",
    isEnabled: false
  });
  // D15: no built-in carries its own user agent any more (guests get main's clean Chrome UA).
  assert.equal(stored.userAgent, null, "the definition's user agent wins over a stored one");
  assert.equal(stored.supportsBadgeDetection, true);
  assert.equal(stored.sessionPartition, "persist:service-teams");
  assert.equal(stored.useDefaultSession, false);
  assert.equal(stored.isBuiltIn, true);
  assert.equal(stored.name, "Work Teams");
  assert.equal(stored.isEnabled, false);
});

test("persisted built-ins keep only user-owned fields that differ from the definition", () => {
  assert.deepEqual(toPersistedService(normalizeService({ id: "gmail" })), { id: "gmail" });
  const customised = normalizeService({ id: "gmail", isEnabled: false, zoomFactor: 1.2, keepAliveInBackground: true });
  assert.deepEqual(toPersistedService(customised), {
    id: "gmail",
    isEnabled: false,
    zoomFactor: 1.2,
    keepAliveInBackground: true
  });
  const custom = toPersistedService(normalizeService({ id: "c1", name: "C", url: "https://c.example" }));
  assert.equal(custom.isBuiltIn, undefined);
  assert.equal(custom.sessionPartition, "persist:service-c1");
  assert.equal(custom.url, "https://c.example");
});

test("historical Messenger URLs are treated as the built-in default", () => {
  const messenger = normalizeService({ id: "messenger", url: "https://www.messenger.com/" });
  assert.equal(messenger.url, builtInServices.find((service) => service.id === "messenger").url);
  assert.deepEqual(toPersistedService(messenger), { id: "messenger" });
});

test("invalid URLs never replace a valid one and are not swapped for a placeholder", () => {
  const existing = normalizeService({ id: "c1", name: "C", url: "https://c.example" });
  assert.equal(normalizeService({ id: "c1", url: "javascript:alert(1)" }, existing).url, "https://c.example");
  assert.equal(normalizeService({ id: "c2", url: "mailto:x@y.z" }).url, "mailto:x@y.z");
  assert.equal(normalizeService({ id: "c3" }).url, "");
  assert.equal(normalizeService({ id: "gmail", url: "file:///etc/passwd" }).url, builtInServices[0].url);
});

test("v1 configs migrate once: frozen built-in fields stripped, history purged", () => {
  const v1 = {
    services: [
      { ...builtInServices[0], userAgent: null },
      { ...teams, userAgent: "Old/1.0", supportsBadgeDetection: false },
      { id: "custom", name: "Custom", url: "https://custom.example", isBuiltIn: false }
    ],
    ui: { activeServiceId: "custom", windowMode: "dock", notificationLastSeenByService: { gmail: "2026-01-01T00:00:00.000Z" } },
    notificationHistory: [{ id: "1", serviceId: "gmail", title: "secret" }]
  };
  const { config, changed } = migrateConfig(v1);
  assert.equal(changed, true);
  const persisted = toPersistedConfig(config);
  assert.equal(persisted.configVersion, CONFIG_VERSION);
  assert.deepEqual(persisted.services.slice(0, 2), [{ id: "gmail" }, { id: "teams" }]);
  assert.equal(persisted.services[2].id, "custom");
  assert.deepEqual(persisted.services.slice(3).map((service) => service.id), ["discord", "messenger", "slack"]);
  assert.equal("notificationHistory" in persisted, false);
  assert.equal("notificationLastSeenByService" in persisted.ui, false);
  assert.equal(persisted.ui.windowMode, "dock");
  assert.equal(config.services.find((service) => service.id === "teams").userAgent, null, "a frozen built-in UA is dropped");

  const again = migrateConfig(JSON.parse(JSON.stringify(persisted)));
  assert.equal(again.changed, false, "a migrated file is not rewritten again");
  assert.deepEqual(toPersistedConfig(again.config), persisted);
});

test("v1 desktop alerts off is re-enabled only where the page's own toasts still showed", () => {
  const off = { desktopEnabled: false, badgeEnabled: true, captureWebNotifications: true };
  const allOff = { desktopEnabled: false, badgeEnabled: false, captureWebNotifications: false };
  const v1 = {
    services: [
      { id: "discord", notificationSettings: off },
      { id: "messenger", notificationSettings: allOff },
      { id: "custom", name: "Custom", url: "https://custom.example", notificationSettings: { desktopEnabled: false } }
    ],
    ui: { notificationsEnabled: false }
  };
  const { config } = migrateConfig(v1);
  const byId = (id) => config.services.find((service) => service.id === id).notificationSettings;
  assert.deepEqual(byId("discord"), { ...off, desktopEnabled: true });
  assert.deepEqual(byId("messenger"), allOff, "an app with capture off too is left alone");
  assert.equal(byId("custom").desktopEnabled, true, "missing capture flag meant capture on");
  assert.equal(config.ui.notificationsEnabled, false, "the global switch is left alone");
  const persisted = toPersistedConfig(config);
  assert.equal("notificationSettings" in persisted.services.find((service) => service.id === "discord"), false);

  const v2 = migrateConfig({ ...v1, configVersion: CONFIG_VERSION }).config;
  const v2ById = (id) => v2.services.find((service) => service.id === id).notificationSettings;
  assert.deepEqual(v2ById("discord"), off, "a v2 file is never rewritten this way");
  assert.equal(v2ById("custom").desktopEnabled, false);
  assert.equal(v2.ui.notificationsEnabled, false);
});

test("ui normalization fills new fields and validates values", () => {
  const services = [normalizeService({ id: "a", url: "https://a.example", isEnabled: false }), normalizeService({ id: "b", url: "https://b.example" })];
  const ui = normalizeUi({
    activeServiceId: "a",
    windowMode: "floating",
    dockCorner: "nowhere",
    dockHeight: 5000,
    memorySaverTimeoutMinutes: 3,
    closeToTray: "yes",
    bubbleSize: { width: 1, height: 99999 },
    unknownKey: true
  }, services);
  assert.deepEqual(ui, {
    activeServiceId: "b",
    notificationsEnabled: true,
    memorySaverEnabled: true,
    memorySaverTimeoutMinutes: 10,
    sidebarCollapsed: false,
    windowMode: "full",
    dockCorner: "bottom-left",
    dockHeight: 720,
    dockExpanded: true,
    bubbleSize: { width: 560, height: 2160 },
    closeToTray: false,
    launchAtLogin: false,
    startMinimized: false,
    askWhereToSaveDownloads: false
  });
  assert.equal(normalizeUi({}, [services[0]]).activeServiceId, null);
});

test("app settings whitelist", () => {
  assert.deepEqual(
    sanitizeAppSettings({
      memorySaverTimeoutMinutes: 30,
      closeToTray: true,
      launchAtLogin: false,
      startMinimized: "true",
      askWhereToSaveDownloads: true,
      windowMode: "dock",
      activeServiceId: "x"
    }),
    { memorySaverTimeoutMinutes: 30, closeToTray: true, launchAtLogin: false, askWhereToSaveDownloads: true }
  );
  assert.deepEqual(sanitizeAppSettings({ memorySaverTimeoutMinutes: 7 }), {});
  assert.deepEqual(sanitizeAppSettings(null), {});
});

test("config shape validation and permission decision normalization", () => {
  assert.equal(validateConfigShape({}), null);
  assert.match(validateConfigShape([]), /root/);
  assert.match(validateConfigShape({ services: "x" }), /services/);
  assert.match(validateConfigShape({ ui: [] }), /ui/);
  assert.match(validateConfigShape({ notificationHistory: {} }), /notificationHistory/);
  assert.deepEqual(normalizePermissionDecisions({
    s1: {
      "https://meet.example": { camera: "allow", microphone: "block", bogus: "maybe" },
      "https://meet.example/path": { camera: "allow" },
      "file://x": { camera: "allow" }
    },
    s2: "nope"
  }), { s1: { "https://meet.example": { camera: "allow", microphone: "block" } } });
});

test("snapshot is frozen, memoized and carries limits but no history", () => {
  const state = buildAppState(migrateConfig(v2Config()).config, { dockModeSupported: true, dockModeUnavailableReason: null });
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.services[0]) && Object.isFrozen(state.ui.bubbleSize));
  assert.equal("notificationHistory" in state, false);
  assert.deepEqual(state.limits, rendererLimits);
  assert.throws(() => { state.ui.windowMode = "dock"; }, TypeError);
});

test("store reads the backing once and serves memoized snapshots", () => {
  const { store, backing, timers } = createStore(v2Config());
  const first = store.getAppState();
  for (let index = 0; index < 50; index += 1) assert.equal(store.getAppState(), first);
  assert.equal(backing.loads, 1);
  assert.equal(timers.pending().length, 0, "an up-to-date file is not rewritten");
  assert.equal(first.ui.activeServiceId, "custom");
  assert.equal(first.capabilities.dockModeSupported, true);
});

test("store debounces writes into one atomic save and skips no-op updates", () => {
  const { store, backing, timers } = createStore(v2Config());
  const before = store.getAppState();
  assert.equal(store.setUiState({ windowMode: "full" }), before, "no-op returns the same snapshot");
  assert.equal(timers.pending().length, 0);

  store.setUiState({ windowMode: "dock" });
  store.setUiState({ dockExpanded: false });
  const after = store.setUiState({ dockCorner: "top-right" });
  assert.notEqual(after, before);
  assert.equal(after.ui.windowMode, "dock");
  assert.equal(after.ui.dockCorner, "top-right");
  assert.equal(backing.saves.length, 0, "writes are deferred");
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].delay, 250);
  timers.runAll();
  assert.equal(backing.saves.length, 1);
  assert.equal(backing.saves[0].ui.dockCorner, "top-right");
  assert.equal(backing.loads, 1);
});

test("flush writes synchronously and only when dirty", () => {
  const { store, backing } = createStore(v2Config());
  assert.equal(store.flush(), true);
  assert.equal(backing.saves.length, 0);
  store.setUiState({ sidebarCollapsed: true });
  assert.equal(store.hasPendingWrites(), true);
  assert.equal(store.flush(), true);
  assert.equal(backing.saves.length, 1);
  assert.equal(store.hasPendingWrites(), false);
  assert.equal(store.flush(), true);
  assert.equal(backing.saves.length, 1);
});

test("failed writes are logged once, kept in memory and retried with backoff", () => {
  const { store, backing, timers, logs } = createStore(v2Config());
  backing.failSaves = 2;
  const state = store.setUiState({ sidebarCollapsed: true });
  assert.equal(state.ui.sidebarCollapsed, true);
  timers.runAll();
  assert.equal(backing.saves.length, 0);
  assert.equal(timers.pending()[0].delay, 2000);
  timers.runAll();
  assert.equal(timers.pending()[0].delay, 4000);
  timers.runAll();
  assert.equal(backing.saves.length, 1);
  assert.equal(logs.filter((message) => /Failed to save/.test(message)).length, 1);
  assert.equal(store.getAppState().ui.sidebarCollapsed, true);
});

test("fresh, corrupt and legacy files are written once; unreadable files are never overwritten", () => {
  const fresh = createStore(undefined);
  assert.equal(fresh.store.getAppState().services.length, builtInServices.length);
  fresh.timers.runAll();
  assert.equal(fresh.backing.saves.length, 1);
  assert.equal(fresh.store.getLoadIssue(), null);

  const corrupt = createStore(null, { status: "corrupt" });
  assert.equal(corrupt.store.getAppState().ui.activeServiceId, "gmail");
  corrupt.timers.runAll();
  assert.equal(corrupt.backing.saves.length, 1);
  assert.match(corrupt.logs[0], /reset to defaults.*backup\.json/);
  assert.deepEqual(corrupt.store.getLoadIssue(), { status: "corrupt", backupPath: "backup.json" });

  const unreadable = createStore(null, { status: "unreadable" });
  unreadable.store.getAppState();
  unreadable.store.setUiState({ windowMode: "dock" });
  assert.equal(unreadable.store.getAppState().ui.windowMode, "dock");
  unreadable.timers.runAll();
  unreadable.store.flush();
  assert.equal(unreadable.backing.saves.length, 0);
  assert.match(unreadable.logs[0], /could not read/);
  assert.equal(unreadable.store.getLoadIssue().status, "unreadable");
});

test("stored custom partitions are preserved verbatim", () => {
  const legacy = normalizeService({ id: "c1", url: "https://c.example", sessionPartition: "persist:Legacy Partition #1" });
  assert.equal(legacy.sessionPartition, "persist:Legacy Partition #1");
  assert.equal(normalizeService({ id: "c2", url: "https://c.example", sessionPartition: "" }).sessionPartition, "persist:service-c2");
  assert.equal(normalizeService({ id: "c3", url: "https://web.wechat.com/" }).sessionPartition, null);
});

test("service mutations keep the active service consistent", () => {
  const { store } = createStore(v2Config());
  let state = store.upsertService({ name: "New", url: "https://new.example" });
  const created = state.services.at(-1);
  assert.equal(created.id, "generated-1");
  assert.equal(state.ui.activeServiceId, "generated-1", "a new enabled app becomes active");

  state = store.upsertService({ ...created, isEnabled: false });
  assert.notEqual(state.ui.activeServiceId, "generated-1");

  const unchanged = store.getAppState();
  assert.equal(store.upsertService({ ...unchanged.services[0] }), unchanged, "identical save is a no-op");

  state = store.reorderServices(["slack", "custom"]);
  assert.deepEqual(state.services.slice(0, 2).map((service) => service.id), ["slack", "custom"]);
  assert.equal(store.reorderServices(["slack", "custom"]), state);

  assert.equal(store.removeService("gmail").services.some((service) => service.id === "gmail"), true, "built-ins cannot be removed");
  state = store.removeService("custom");
  assert.equal(state.services.some((service) => service.id === "custom"), false);
});

test("permission decisions are persisted per service and origin and cleared with the service", () => {
  const { store, backing } = createStore(v2Config());
  const snapshot = store.getAppState();
  assert.equal(store.setPermissionDecision("custom", "https://meet.example", "camera", "allow"), true);
  assert.equal(store.setPermissionDecision("custom", "https://meet.example", "microphone", "block"), true);
  assert.equal(store.setPermissionDecision("custom", "https://meet.example/path", "camera", "allow"), false);
  assert.equal(store.setPermissionDecision("missing", "https://meet.example", "camera", "allow"), false);
  assert.equal(store.setPermissionDecision("custom", "https://meet.example", "camera", "maybe"), false);
  assert.equal(store.getAppState(), snapshot, "decisions do not invalidate the renderer snapshot");
  assert.equal(store.getPermissionDecision("custom", "https://meet.example", "camera"), "allow");
  assert.equal(store.getPermissionDecision("custom", "https://meet.example", "microphone"), "block");
  assert.equal(store.getPermissionDecision("custom", "https://other.example", "camera"), null);
  store.flush();
  assert.deepEqual(backing.saves.at(-1).permissionDecisions, {
    custom: { "https://meet.example": { camera: "allow", microphone: "block" } }
  });

  assert.equal(store.setPermissionDecision("custom", "https://meet.example", "camera", null), true);
  assert.equal(store.getPermissionDecision("custom", "https://meet.example", "camera"), null);
  assert.equal(store.hasPermissionDecisions("custom"), true);
  assert.equal(store.clearPermissionDecisions("custom"), true, "the rail menu's reset forgets every origin");
  assert.equal(store.hasPermissionDecisions("custom"), false);
  assert.equal(store.getPermissionDecision("custom", "https://meet.example", "microphone"), null);
  assert.equal(store.setPermissionDecision("custom", "https://meet.example", "microphone", "block"), true);
  store.removeService("custom");
  store.flush();
  assert.deepEqual(backing.saves.at(-1).permissionDecisions, {});
  assert.equal(store.clearPermissionDecisions("custom"), false);
});

test("app settings go through the whitelist", () => {
  const { store } = createStore(v2Config());
  const state = store.setAppSettings({ memorySaverTimeoutMinutes: 60, closeToTray: true, windowMode: "dock" });
  assert.equal(state.ui.memorySaverTimeoutMinutes, 60);
  assert.equal(state.ui.closeToTray, true);
  assert.equal(state.ui.windowMode, "full");
});
