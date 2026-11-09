import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { iconLibrary } from "../electron/appStateModel.js";
import { createConfigStore } from "../electron/configStoreCore.js";
import {
  ICON_UPLOAD_MAX_BYTES,
  fitWithin,
  iconExtension,
  iconUploadProblem,
  isAllowedIconSource,
  isPathInside,
  sanitizeServiceInput
} from "../electron/serviceInput.js";
import { UNTRUSTED_SENDER_MESSAGE, createShellIpc } from "../electron/shellIpc.js";

const winIcons = { iconsDir: "C:\\Users\\Gary Yang\\AppData\\Roaming\\Comms Hub\\icons", platform: "win32" };
const libraryIcons = iconLibrary.map((icon) => icon.iconSource);

test("icon uploads: allowed types only, at most 1 MB, shrunk to 256 px", () => {
  assert.equal(iconExtension("C:\\x\\Logo.PNG"), "png");
  assert.equal(iconExtension("noextension"), "");
  assert.equal(iconUploadProblem({ extension: "png", size: 2048 }), null);
  assert.equal(iconUploadProblem({ extension: "svg", size: ICON_UPLOAD_MAX_BYTES }), null);
  assert.match(iconUploadProblem({ extension: "exe", size: 10 }), /PNG, JPEG/);
  assert.match(iconUploadProblem({ extension: "", size: 10 }), /PNG, JPEG/);
  assert.match(iconUploadProblem({ extension: "png", size: ICON_UPLOAD_MAX_BYTES + 1 }), /smaller than 1 MB/);
  assert.match(iconUploadProblem({ extension: "png", size: 0 }), /empty/);
  assert.match(iconUploadProblem({ extension: "png", size: 10, isFile: false }), /image file/);
  assert.deepEqual(fitWithin({ width: 1024, height: 512 }), { width: 256, height: 128 });
  assert.deepEqual(fitWithin({ width: 64, height: 64 }), { width: 64, height: 64 }, "never scaled up");
  assert.equal(fitWithin({ width: 0, height: 10 }), null);
});

test("path containment rejects lookalike siblings and parent segments", () => {
  assert.equal(isPathInside("C:\\data\\icons\\a.png", "C:\\data\\icons", "win32"), true);
  assert.equal(isPathInside("c:\\DATA\\Icons\\a.png", "C:\\data\\icons", "win32"), true);
  assert.equal(isPathInside("C:\\data\\icons-evil\\a.png", "C:\\data\\icons", "win32"), false);
  assert.equal(isPathInside("C:\\data\\icons\\..\\secret.png", "C:\\data\\icons", "win32"), false);
  assert.equal(isPathInside("C:\\data\\icons", "C:\\data\\icons", "win32"), false);
  assert.equal(isPathInside("/data/icons/a.png", "/data/icons", "linux"), true);
  assert.equal(isPathInside("/data/Icons/a.png", "/data/icons", "linux"), false);
});

test("only library icons, small image data URLs and copied icon files may be shown", () => {
  const allowed = (value, options = winIcons) => isAllowedIconSource(value, { ...options, libraryIcons });
  assert.equal(allowed(libraryIcons[0]), true);
  assert.equal(allowed("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(allowed("data:image/svg+xml;charset=UTF-8,%3Csvg%3E"), true);
  assert.equal(allowed(`data:image/png;base64,${"A".repeat(300000)}`), false, "huge data URLs are refused");
  assert.equal(allowed("data:text/html,<script>"), false);
  assert.equal(allowed("file:///C:/Users/Gary%20Yang/AppData/Roaming/Comms%20Hub/icons/a.png"), true);
  assert.equal(allowed("file://C:/Users/Gary Yang/AppData/Roaming/Comms Hub/icons/old.png"), true, "the old two-slash form");
  assert.equal(allowed("file:///C:/Users/Gary%20Yang/AppData/Roaming/Comms%20Hub/icons-evil/a.png"), false);
  assert.equal(allowed("file:///C:/Users/Gary%20Yang/AppData/Roaming/Comms%20Hub/icons/../config.json"), false);
  assert.equal(allowed("file://attacker/share/x.png"), false, "UNC icons would leak credentials");
  assert.equal(allowed("file:///C:/Windows/x.png"), false);
  assert.equal(allowed("https://attacker.example/x.png"), false);
  assert.equal(allowed("file:///home/u/.config/Comms Hub/icons/a.png", { iconsDir: "/home/u/.config/Comms Hub/icons", platform: "linux" }), true);
  assert.equal(allowed("file:///anything/icons/a.png", { platform: "win32" }), false, "no icons directory, no file icons");
  assert.equal(allowed(42), false);
});

test("a redirected (UNC) AppData folder keeps its uploaded icons; other servers stay refused", () => {
  const uncIcons = { iconsDir: "\\\\fileserver\\profiles$\\gary\\AppData\\Roaming\\Comms Hub\\icons", platform: "win32" };
  const allowed = (value, options = uncIcons) => isAllowedIconSource(value, { ...options, libraryIcons });
  // What copyIconToUserData returns for that folder.
  const copied = pathToFileURL(`${uncIcons.iconsDir}\\a.png`, { windows: true }).href;
  assert.equal(copied, "file://fileserver/profiles$/gary/AppData/Roaming/Comms%20Hub/icons/a.png");
  assert.equal(allowed(copied), true);
  assert.equal(allowed("file://FILESERVER/profiles$/gary/AppData/Roaming/Comms%20Hub/icons/a.png"), true, "server names ignore case");
  assert.equal(allowed("file://otherhost/profiles$/gary/AppData/Roaming/Comms%20Hub/icons/a.png"), false);
  assert.equal(allowed("file://fileserver/profiles$/gary/AppData/Roaming/Comms%20Hub/icons-evil/a.png"), false);
  assert.equal(allowed("file://fileserver/other$/gary/AppData/Roaming/Comms%20Hub/icons/a.png"), false);
  assert.equal(allowed("file://fileserver/profiles$/gary/AppData/Roaming/Comms%20Hub/icons/../comms-app-config.json"), false);
  assert.equal(allowed(copied, winIcons), false, "a local icons folder accepts no server");
  assert.equal(allowed(copied, { iconsDir: "/home/u/.config/Comms Hub/icons", platform: "linux" }), false);

  const service = sanitizeServiceInput({ iconSource: copied, iconKey: "custom" }, null, uncIcons);
  assert.deepEqual(service, { iconSource: copied, iconKey: "custom" });
});

test("an icon key is dropped together with a refused icon", () => {
  assert.deepEqual(sanitizeServiceInput({ iconSource: "file://attacker/share/x.png", iconKey: "custom" }, null, winIcons), {});
  assert.deepEqual(sanitizeServiceInput({ iconSource: 42, iconKey: "custom" }, null, winIcons), {});
  assert.deepEqual(sanitizeServiceInput({ iconKey: "globe" }, null, winIcons), { iconKey: "globe" }, "a key alone is kept");
  const existing = { id: "x", iconSource: "file://C:/legacy/icon.png", iconKey: "custom" };
  assert.deepEqual(
    sanitizeServiceInput({ iconSource: existing.iconSource, iconKey: "custom" }, existing, winIcons),
    { id: "x", iconSource: existing.iconSource, iconKey: "custom" },
    "an unchanged icon keeps its key"
  );
});

test("renderer service data keeps only user-editable fields", () => {
  const existing = {
    id: "custom", name: "Old", url: "https://old.example/", iconSource: "file://C:/legacy/icon.png", iconKey: "custom",
    isBuiltIn: false, isEnabled: true, sessionPartition: "persist:service-custom", supportsBadgeDetection: true,
    keepAliveInBackground: false, zoomFactor: 1, userAgent: null, useDefaultSession: false,
    notificationSettings: { desktopEnabled: false, badgeEnabled: true, captureWebNotifications: true }
  };
  const sanitized = sanitizeServiceInput({
    ...existing,
    id: "custom",
    name: `  ${"N".repeat(200)}  `,
    isBuiltIn: true,
    sessionPartition: "persist:service-gmail",
    useDefaultSession: true,
    userAgent: "Evil/1.0",
    supportsBadgeDetection: false,
    iconKey: "../../etc",
    isEnabled: "yes",
    zoomFactor: Number.NaN,
    notificationSettings: { badgeEnabled: false, desktopEnabled: "no", extra: true }
  }, existing, { ...winIcons, libraryIcons });
  assert.deepEqual(sanitized, {
    id: "custom",
    name: "N".repeat(80),
    url: "https://old.example/",
    iconSource: "file://C:/legacy/icon.png",
    keepAliveInBackground: false,
    notificationSettings: { desktopEnabled: false, badgeEnabled: false, captureWebNotifications: true }
  });
  assert.equal(sanitizeServiceInput({ id: "unknown", name: "New" }, null).id, undefined, "main assigns new ids");
  assert.equal(sanitizeServiceInput({ iconSource: "file://attacker/share/x.png" }, null, winIcons).iconSource, undefined);
  assert.deepEqual(sanitizeServiceInput(null, null), {});
});

function createStore(initial) {
  let ids = 0;
  const backing = { load: () => ({ status: initial ? "ok" : "missing", data: structuredClone(initial ?? null) }), save: () => {} };
  return createConfigStore({
    backing,
    platform: "win32",
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    createId: () => `generated-${++ids}`
  });
}

const save = (store, input) => {
  const existing = store.getAppState().services.find((service) => service.id === input.id) ?? null;
  return store.upsertService(sanitizeServiceInput(input, existing, { ...winIcons, libraryIcons }));
};

test("saving through the sanitizer: main derives identity and session for new services", () => {
  const store = createStore();
  const state = save(store, {
    id: "hacker", name: "Evil", url: "https://evil.example/", isBuiltIn: true,
    sessionPartition: "persist:service-gmail", useDefaultSession: true, userAgent: "X"
  });
  const created = state.services.at(-1);
  assert.equal(created.id, "generated-1");
  assert.equal(created.isBuiltIn, false);
  assert.equal(created.sessionPartition, "persist:service-generated-1");
  assert.equal(created.useDefaultSession, false);
  assert.equal(created.userAgent, null);
  assert.equal(store.removeService("generated-1").services.some((service) => service.id === "generated-1"), false,
    "a renderer cannot make a service unremovable");

  const wechat = save(store, { name: "WeChat", url: "https://web.wechat.com/" }).services.at(-1);
  assert.equal(wechat.useDefaultSession, true, "compatibility overrides still apply");
  assert.equal(wechat.sessionPartition, null);
});

test("saving through the sanitizer keeps code-owned fields of existing services", () => {
  const store = createStore({
    configVersion: 2,
    services: [{ id: "account-a", name: "A", url: "http://127.0.0.1:5000/a", sessionPartition: "persist:account-a", userAgent: "Custom/1" }]
  });
  const teams = store.getAppState().services.find((service) => service.id === "teams");
  const nextTeams = save(store, { ...teams, userAgent: null, sessionPartition: "persist:other", keepAliveInBackground: true })
    .services.find((service) => service.id === "teams");
  assert.equal(nextTeams.userAgent, teams.userAgent);
  assert.equal(nextTeams.sessionPartition, "persist:service-teams");
  assert.equal(nextTeams.keepAliveInBackground, true);

  const account = store.getAppState().services.find((service) => service.id === "account-a");
  const next = save(store, { ...account, sessionPartition: "persist:service-gmail", useDefaultSession: true, userAgent: "Evil", name: "Renamed" })
    .services.find((service) => service.id === "account-a");
  assert.equal(next.sessionPartition, "persist:account-a");
  assert.equal(next.useDefaultSession, false);
  assert.equal(next.userAgent, "Custom/1");
  assert.equal(next.name, "Renamed");

  const toggled = save(store, { id: "account-a", notificationSettings: { desktopEnabled: false } })
    .services.find((service) => service.id === "account-a");
  assert.deepEqual(toggled.notificationSettings, { desktopEnabled: false, badgeEnabled: true, captureWebNotifications: true },
    "a partial toggle keeps the other flags");
});

test("shell IPC refuses untrusted senders before the handler runs", async () => {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener)
  };
  const rejected = [];
  const calls = [];
  const shellIpc = createShellIpc({
    ipcMain,
    isTrustedSender: (event) => {
      if (event.explode) throw new Error("frame disposed");
      return event.trusted;
    },
    onRejected: (channel) => rejected.push(channel)
  });
  shellIpc.handle("services:save", (_event, value) => { calls.push(value); return "saved"; });
  shellIpc.on("services:set-viewport", (_event, value) => calls.push(value));

  assert.equal(await handlers.get("services:save")({ trusted: true }, 1), "saved");
  assert.throws(() => handlers.get("services:save")({ trusted: false }, 2), { message: UNTRUSTED_SENDER_MESSAGE });
  assert.throws(() => handlers.get("services:save")({ explode: true }, 3), { message: UNTRUSTED_SENDER_MESSAGE });
  listeners.get("services:set-viewport")({ trusted: true }, 4);
  listeners.get("services:set-viewport")({ trusted: "yes" }, 5);
  assert.deepEqual(calls, [1, 4]);
  assert.deepEqual(rejected, ["services:save", "services:save", "services:set-viewport"]);
});
