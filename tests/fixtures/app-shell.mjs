import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, Notification, screen, session, shell, Tray, webContents } from "electron";

// Exercise production IPC and renderer using synthetic accounts and hidden native windows.
// No account/profile data or remote service is used by this fixture.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const userData = process.env.COMMS_ELECTRON_USER_DATA;
if (!userData) throw new Error("Start this fixture using scripts/run-electron-tests.mjs.");
app.setPath("userData", userData);
app.setPath("sessionData", path.join(userData, "sessions"));
// Downloads land in the temporary profile, never the user's Downloads folder.
const downloadsDir = path.join(userData, "downloads");
app.setPath("downloads", downloadsDir);
const simulateLinux = process.argv.includes("--linux") || process.env.COMMS_TEST_LINUX === "1";
if (simulateLinux) Object.defineProperty(process, "platform", { value: "linux" });
globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: "v1.2.2", assets: [] }) });

// Count settings-file I/O. The store calls these through the shared node:fs object.
const configFileName = "comms-app-config.json";
const configPath = path.join(userData, configFileName);
const configIo = { reads: 0, writes: 0 };
const isConfigFile = (value) => typeof value === "string" && path.basename(value) === configFileName;
const originalReadFileSync = syncFs.readFileSync;
syncFs.readFileSync = function readFileSync(file, ...args) {
  if (isConfigFile(file)) configIo.reads += 1;
  return originalReadFileSync.call(this, file, ...args);
};
const originalRenameSync = syncFs.renameSync;
syncFs.renameSync = function renameSync(from, to) {
  if (isConfigFile(to)) configIo.writes += 1;
  return originalRenameSync.call(this, from, to);
};
// Shorten main's 45 s dock-window teardown grace period so the teardown can be observed.
const dockTeardownDelayMs = 45000;
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  originalSetTimeout(callback, delay === dockTeardownDelayMs ? 1500 : delay, ...args);
// Observe the tray's menu and tooltip as main sets them.
const trayState = { menu: null, toolTip: null, menus: 0 };
for (const [method, record] of [
  ["setContextMenu", (menu) => { trayState.menu = menu; trayState.menus += 1; }],
  ["setToolTip", (toolTip) => { trayState.toolTip = toolTip; }]
]) {
  const original = Tray.prototype[method];
  Tray.prototype[method] = function patched(value) {
    record(value);
    return original.call(this, value);
  };
}
const trayItem = (label) => trayState.menu?.items.find((item) => item.label === label);
// Toasts are recorded instead of shown on the user's desktop.
const toasts = [];
Notification.prototype.show = function show() { toasts.push(this); };
// Nothing leaves the test: external opens are recorded and native dialogs answered from a queue
// (default: the dialog's Cancel button). main.js looks both up at call time.
const externalOpens = [];
shell.openExternal = async (url) => { externalOpens.push(url); };
const shownInFolder = [];
shell.showItemInFolder = (filePath) => { shownInFolder.push(filePath); };
// Context menus are recorded instead of popped up; tests click their items directly.
const menuPopups = [];
Menu.prototype.popup = function popup(options) { menuPopups.push({ menu: this, options }); };
const menuLabels = (menu) => menu.items.filter((item) => item.type !== "separator").map((item) => item.label);
const menuItem = (menu, label) => menu.items.find((item) => item.label === label);
const dialogCalls = [];
const dialogAnswers = [];
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  dialogCalls.push(options);
  const answer = dialogAnswers.shift();
  if (answer instanceof Error) throw answer;
  return answer ?? { response: options.cancelId ?? 0, checkboxChecked: false };
};
// Launches a second copy of the app on this profile; it must hand over and exit with code 0.
const launchSecondInstance = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "second-instance.mjs")], {
    env: { ...process.env, COMMS_ELECTRON_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = originalSetTimeout(() => { child.kill(); reject(new Error(`second instance did not exit: ${output}`)); }, 20000);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
});

const windows = [];
const shellErrors = [];
const sentMessages = new WeakMap();
const sentCount = (window, channel) => sentMessages.get(window)?.get(channel) ?? 0;
// hide() calls per window, including calls on a window that is not shown (a native hide() is what
// makes a never-shown page report itself hidden).
const hideCalls = new WeakMap();
const liveWindow = (marker) =>
  windows.findLast((window) => !window.isDestroyed() && window.webContents.getURL().includes(marker));
app.on("browser-window-created", (_event, window) => {
  windows.push(window);
  const counts = new Map();
  sentMessages.set(window, counts);
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
    return send(channel, ...args);
  };
  let visible = false;
  // Keep native windows hidden on the user's desktop while exercising lifecycle events.
  window.show = window.showInactive = () => { if (!visible) { visible = true; window.emit("show"); } };
  window.hide = () => {
    hideCalls.set(window, (hideCalls.get(window) ?? 0) + 1);
    if (visible) { visible = false; window.emit("hide"); }
  };
  window.isVisible = () => visible;
  window.focus = window.moveTop = () => {};
  window.webContents.on("preload-error", (_event, _preload, error) => shellErrors.push(String(error)));
  window.webContents.on("console-message", (_event, details) => {
    if (details?.level === "error") shellErrors.push(details.message);
  });
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const poll = async (check, label, timeout = 10000) => {
  const end = Date.now() + timeout;
  let error;
  do {
    try { const result = await check(); if (result) return result; } catch (caught) { error = caught; }
    await delay(25);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ""}`);
};
// Polls the saved settings file. Reading it every 25 ms can hold it open just as main renames the new
// copy over it (EPERM on Windows), and each failed save then waits seconds before retrying.
const pollSavedConfig = (check, label) => poll(async () => {
  await delay(225);
  return check(JSON.parse(await fs.readFile(configPath, "utf8")));
}, label, 20000);
const server = http.createServer((request, response) => {
  if (request.url.startsWith("/download/")) {
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="report.txt"' });
    response.end("fixture report");
    return;
  }
  if (request.url === "/redirect-home") {
    // A home address that lands on the other site through a server redirect.
    response.writeHead(302, { Location: `http://localhost:${server.address().port}/landed` });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  if (request.url.startsWith("/frame")) {
    response.end('<!doctype html><title>Embed</title><a id="mail" href="mailto:fixture@example.com">Mail</a>');
    return;
  }
  response.end(`<!doctype html><title>Account ${request.url}</title><style>body{margin:0;background:white;color:#111}main{width:100%;box-sizing:border-box;border:2px solid blue}textarea{width:70%}</style><main><h1>Account ${request.url}</h1><textarea id="draft"></textarea><button id="right" style="float:right">Right edge</button></main>`);
});
app.whenReady().then(async () => {
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(configPath, JSON.stringify({
  services: [
    ...["gmail", "discord", "messenger", "slack", "teams"].map((id) => ({ id, isEnabled: false })),
    ...["account-a", "account-b"].map((id) => ({ id, name: id, url: `${origin}/${id}`, isEnabled: true,
      sessionPartition: `persist:${id}`, keepAliveInBackground: true,
      notificationSettings: { desktopEnabled: false, captureWebNotifications: true, badgeEnabled: true } }))
  ],
  ui: { activeServiceId: "account-a", memorySaverEnabled: true, notificationsEnabled: false,
    windowMode: simulateLinux || process.platform === "linux" ? "dock" : "full", sidebarCollapsed: false, dockExpanded: true,
    startMinimized: true },
  notificationHistory: []
}));

const results = [];
const run = async (name, check) => { await check(); results.push({ name, ok: true }); };
const processCounts = {};
let report;
try {
  await import("../../electron/main.js");
  const main = await poll(() => windows[0], "main window");
  const execute = (script) => main.webContents.executeJavaScript(script);
  await poll(() => execute("Boolean(window.commsApp && document.querySelector('.service-viewport'))"), "renderer ready");
  await run("a minimized start stays in the tray until a second launch reveals the app", async () => {
    assert.equal(app.hasSingleInstanceLock(), true);
    await delay(300);
    assert.equal(main.isVisible(), false, "startMinimized keeps the main window hidden");
    assert.ok((hideCalls.get(main) ?? 0) >= 1, "the never-shown main window is hidden natively, so its page stops polling");
    const second = await launchSecondInstance();
    assert.equal(second.code, 0, `the second instance exits cleanly: ${second.output}`);
    await poll(() => main.isVisible(), "the running app is revealed by the second launch");
    assert.equal(BrowserWindow.getAllWindows().length, 1, "the second launch opened no windows here");
  });
  const getState = () => execute("window.commsApp.getState()");
  const getRuntime = () => execute("window.commsApp.getServiceRuntime()");
  const getId = async (id) => (await getRuntime()).services[id]?.webContentsId;
  await poll(async () => (await getRuntime()).services["account-a"]?.status === "active", "active account ready");
  const firstId = await getId("account-a");
  const secondId = await getId("account-b");
  const firstPage = webContents.fromId(firstId);
  await run("production preload and independent same-origin accounts", async () => {
    assert.notEqual(firstId, secondId);
    await firstPage.executeJavaScript("document.cookie='account=A'; document.querySelector('#draft').value='Draft kept through mode changes';");
    const secondPage = webContents.fromId(secondId);
    await poll(() => secondPage.executeJavaScript("document.readyState === 'complete'"), "second account ready");
    assert.equal(await secondPage.executeJavaScript("document.cookie"), "");
    assert.equal((await getState()).services.find((service) => service.id === "account-a").sessionPartition, "persist:account-a");
  });
  await run("settings modal hides the native page without unloading it", async () => {
    await execute("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Edit').click()");
    await poll(() => execute("Boolean(document.querySelector('.modal-backdrop'))"), "settings dialog");
    await poll(() => !main.contentView.children.some((child) => child.webContents?.id === firstId), "native page hidden behind modal");
    assert.equal(await getId("account-a"), firstId);
    await execute("document.querySelector('.modal .ghost-button').click()");
    await poll(() => main.contentView.children.some((child) => child.webContents?.id === firstId), "native page restored");
    assert.equal(await firstPage.executeJavaScript("document.querySelector('#draft').value"), "Draft kept through mode changes");
  });

  if (simulateLinux || process.platform === "linux") {
    await run("Linux saved dock mode opens full app and all activation paths stay disabled", async () => {
      assert.equal((await getState()).ui.windowMode, "full");
      assert.equal((await getState()).capabilities.dockModeSupported, false);
      assert.equal(await execute("document.querySelector('.titlebar-mode-button').disabled"), true);
      assert.match(await execute("document.querySelector('.dock-unavailable-note').textContent"), /unavailable on Linux/);
      await execute("window.commsApp.setWindowMode('dock')");
      await execute("window.commsApp.openDockFromTrigger()");
      await execute("window.commsApp.setDockExpanded(true)");
      screen.emit("display-metrics-changed", {}, screen.getPrimaryDisplay(), ["workArea"]);
      app.emit("activate");
      await delay(200);
      assert.equal((await getState()).ui.windowMode, "full");
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.equal(main.isVisible(), true);
    });
  } else {
    await run("full/dock mode switches reuse pages and honor latest selection", async () => {
      await execute("window.commsApp.setWindowMode('dock')");
      const bubble = await poll(() => liveWindow("mode=bubble"), "bubble");
      await poll(() => bubble.contentView.children.some((child) => child.webContents?.id === firstId), "page reparented to bubble");
      assert.equal(main.contentView.children.some((child) => child.webContents?.id === firstId), false);
      assert.equal(await getId("account-a"), firstId);
      await execute("Promise.all([window.commsApp.setDockExpanded(true), window.commsApp.setActiveService('account-b')])");
      await poll(async () => (await getRuntime()).services["account-b"]?.status === "active", "latest selection");
      assert.equal((await getState()).ui.activeServiceId, "account-b");
      await execute("window.commsApp.setActiveService('account-a')");
      await execute("window.commsApp.setWindowMode('full')");
      await poll(() => main.contentView.children.some((child) => child.webContents?.id === firstId), "page reparented to main");
      assert.equal(await getId("account-a"), firstId);
      assert.equal(await firstPage.executeJavaScript("document.querySelector('#draft').value"), "Draft kept through mode changes");
      assert.equal(Object.values((await getRuntime()).services).filter((service) => service.webContentsId).length, 2);
    });
    await run("bubble size persists and native viewport excludes toolbar", async () => {
      await execute("window.commsApp.setBubbleSize({width:860,height:660})");
      await execute("window.commsApp.setWindowMode('dock')");
      const bubble = liveWindow("mode=bubble");
      await poll(() => bubble.contentView.children.some((child) => child.webContents?.id === firstId), "bubble viewport");
      const view = bubble.contentView.children.find((child) => child.webContents === firstPage);
      const bounds = view.getBounds();
      assert.ok(bounds.y >= 30 && bounds.width > 0);
      assert.ok(bounds.y + bounds.height <= bubble.getContentSize()[1]);
      assert.deepEqual((await getState()).ui.bubbleSize, { width: 860, height: 660 });
      if (process.env.COMMS_CAPTURE_TEST_IMAGES === "1") {
      const artifactDirectory = path.join(root, "out", "verification");
      await fs.mkdir(artifactDirectory, { recursive: true });
      const dock = liveWindow("mode=dock");
      await dock.webContents.executeJavaScript("document.documentElement.style.background='white';document.body.style.background='white'");
      await fs.writeFile(path.join(artifactDirectory, "dock-on-white.png"), (await dock.webContents.capturePage()).toPNG());
      await fs.writeFile(path.join(artifactDirectory, "bubble-toolbar.png"), (await bubble.webContents.capturePage()).toPNG());
      }
      bubble.setSize(700, 560);
      await delay(250);
      assert.deepEqual((await getState()).ui.bubbleSize, { width: 860, height: 660 }, "programmatic resize must preserve preference");
      await execute("window.commsApp.setWindowMode('full')");
    });
    await run("dock mode idles without settings I/O and the static trigger reopens the dock", async () => {
      await execute("window.commsApp.setWindowMode('dock')");
      await poll(() => liveWindow("mode=bubble")?.contentView.children.some((child) => child.webContents?.id === firstId), "dock ready");
      await delay(400); // let the debounced settings write land
      const before = { ...configIo };
      await delay(1000);
      assert.deepEqual(configIo, before, "idle dock mode must not read or write the settings file");
      processCounts.dockMode = app.getAppMetrics().length;

      await execute("window.commsApp.setDockExpanded(false)");
      const trigger = await poll(() => liveWindow("trigger.html"), "trigger window");
      await poll(() => trigger.isVisible(), "trigger shown");
      assert.match(trigger.webContents.getURL(), /trigger\.html\?corner=bottom-left$/);
      await poll(() => trigger.webContents.executeJavaScript("document.readyState === 'complete' && Boolean(window.commsApp)"), "trigger page ready");
      assert.equal(await trigger.webContents.executeJavaScript("document.body.className"), "left-anchored");
      await trigger.webContents.executeJavaScript("document.getElementById('open-dock').click()");
      await poll(async () => (await getState()).ui.dockExpanded === true, "dock reopened from the trigger");
      await poll(() => !trigger.isVisible(), "trigger hidden");

      await execute("window.commsApp.setDockCorner('top-right')");
      await poll(() => trigger.webContents.getURL().includes("corner=top-right"), "trigger follows the dock corner");
      await poll(() => trigger.webContents.executeJavaScript("document.body.className === 'right-anchored'"), "trigger re-anchored");
      await execute("window.commsApp.setDockCorner('bottom-left')");
      await delay(100);
      assert.equal(sentCount(trigger, "state:updated"), 0, "the trigger receives no state broadcasts");
      assert.equal(sentCount(trigger, "services:runtime-updated"), 0, "the trigger receives no runtime broadcasts");
      await execute("window.commsApp.setWindowMode('full')");
    });
    await run("leaving dock mode destroys the dock windows after the grace period", async () => {
      assert.ok(BrowserWindow.getAllWindows().length > 1, "dock windows are kept for quick toggles");
      await poll(() => BrowserWindow.getAllWindows().length === 1, "dock windows destroyed", 10000);
      assert.equal(BrowserWindow.getAllWindows()[0], main);
      assert.ok(main.contentView.children.some((child) => child.webContents?.id === firstId), "page stays on the main window");
      assert.equal(await getId("account-a"), firstId);
      await delay(500);
      processCounts.afterTeardown = app.getAppMetrics().length;
    });
  }
  await run("settings are read once; focus and seen-marking without news write and broadcast nothing", async () => {
    assert.equal(configIo.reads, 1, "the settings file is read once per run");
    await delay(400);
    const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(saved.configVersion, 2);
    assert.equal("notificationHistory" in saved, false, "persisted notification history is purged");
    assert.deepEqual(saved.services.find((service) => service.id === "gmail"), { id: "gmail", isEnabled: false });
    assert.equal("notificationHistory" in await getState(), false);
    assert.deepEqual((await getState()).limits.zoom, { min: 0.5, max: 2, step: 0.1 });

    const writes = configIo.writes;
    const stateSends = sentCount(main, "state:updated");
    main.emit("focus");
    main.emit("focus");
    await execute("window.commsApp.markNotificationsSeen('account-a')");
    await delay(300);
    assert.equal(configIo.writes, writes, "focus must not rewrite the settings file");
    assert.equal(sentCount(main, "state:updated"), stateSends, "focus must not broadcast state");

    await execute("window.commsApp.notifyServiceEvent({ serviceId: 'account-b', title: 'Ping', body: 'Hello' })");
    await poll(async () => (await getRuntime()).unseenNotificationCounts?.["account-b"] === 1, "unseen count in runtime");
    main.emit("focus");
    await delay(100);
    assert.equal((await getRuntime()).unseenNotificationCounts["account-b"], 1, "focusing another service keeps it unseen");
    await execute("window.commsApp.markNotificationsSeen('account-b')");
    await poll(async () => !(await getRuntime()).unseenNotificationCounts["account-b"], "seen clears the count");
    await delay(400);
    assert.equal(configIo.writes, writes, "notification history is memory-only");
  });
  await run("zoom and reload controls reach the selected native page", async () => {
    await execute("window.commsApp.setServiceZoom('account-a', 0.8)");
    assert.equal(firstPage.getZoomFactor(), 0.8);
    assert.equal((await getState()).services.find((service) => service.id === "account-a").zoomFactor, 0.8);
    await execute("window.commsApp.refreshActiveWebview()");
    await poll(() => firstPage.executeJavaScript("document.querySelector('#draft')?.value === ''"), "reload");
    assert.equal(await getId("account-a"), firstId);
    assert.match(await firstPage.executeJavaScript("document.cookie"), /account=A/);
  });
  await run("app settings are whitelisted and dev runs never register a login item", async () => {
    const setLoginItemSettings = app.setLoginItemSettings;
    let loginItemCalls = 0;
    app.setLoginItemSettings = () => { loginItemCalls += 1; };
    try {
      const state = await execute("window.commsApp.setAppSettings({ memorySaverTimeoutMinutes: 15, launchAtLogin: true, closeToTray: 'yes', bogus: 1 })");
      assert.equal(state.ui.memorySaverTimeoutMinutes, 15);
      assert.equal(state.ui.launchAtLogin, true);
      assert.equal(state.ui.closeToTray, false, "non-boolean values are ignored");
      assert.equal("bogus" in state.ui, false);
      assert.equal(loginItemCalls, 0, "an unpackaged run must not register Electron itself at login");
      await execute("window.commsApp.setAppSettings({ launchAtLogin: false, memorySaverTimeoutMinutes: 10 })");
    } finally {
      app.setLoginItemSettings = setLoginItemSettings;
    }
  });
  // The cross-site frame lives on "localhost" while the services use 127.0.0.1.
  const crossOrigin = origin.replace("127.0.0.1", "localhost");
  const embedFrame = () => firstPage.mainFrame.frames.find((frame) => frame.url.startsWith(crossOrigin));
  const attachedToMain = () => main.contentView.children.some((child) => child.webContents?.id === firstId);
  const pageReady = () => poll(() => firstPage.executeJavaScript("document.readyState === 'complete'"), "account page ready");
  // The main window's in-app screen-share picker: its text, or null while none is shown.
  const openPicker = () => execute(`(() => {
    const dialog = document.querySelector('.share-dialog');
    return dialog && {
      subtitle: dialog.querySelector('.share-subtitle')?.textContent ?? null,
      origin: dialog.querySelector('.share-origin')?.textContent ?? null
    };
  })()`);
  const pickerClosed = () => execute("!document.querySelector('.share-dialog')");
  const clickPickerButton = (label) => execute(`Array.from(document.querySelectorAll('.share-dialog button'))
    .find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
  await run("the bridge drops openExternal and only Comms Hub windows may call it", async () => {
    assert.equal(await execute("typeof window.commsApp.openExternal"), "undefined");
    assert.equal(await execute("typeof window.commsApp.respondToScreenShare"), "function");
    const rogue = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(root, "electron", "preload.js"), sandbox: true, contextIsolation: true }
    });
    try {
      await rogue.loadURL(`${origin}/rogue`);
      const answer = await rogue.webContents.executeJavaScript(
        "window.commsApp.getState().then(() => 'answered', (error) => error.message)"
      );
      assert.match(answer, /did not come from a Comms Hub window/, "a foreign page with the preload is refused");
    } finally {
      rogue.destroy();
    }
  });
  await run("service links follow the link policy and never navigate the page", async () => {
    await pageReady();
    const pageUrl = firstPage.getURL();
    externalOpens.length = 0;
    await firstPage.executeJavaScript("window.open('search-ms:query=x'); window.open('https://example.org/'); location.href = 'ms-settings:'; true", true);
    await poll(() => externalOpens.includes("https://example.org/"), "web link handed to the browser");
    await delay(300);
    assert.deepEqual(externalOpens, ["https://example.org/"], "search-ms: and ms-settings: never reach the OS");
    assert.equal(firstPage.getURL(), pageUrl);

    const prompts = dialogCalls.length;
    await firstPage.executeJavaScript("window.open('zoommtg://zoom.us/join?confno=1'); true", true);
    await poll(() => dialogCalls.length > prompts, "app link confirm");
    const confirm = dialogCalls.at(-1);
    assert.equal(confirm.message, "Open Zoom?");
    assert.match(confirm.detail, /account-a wants to open:\nzoommtg:\/\/zoom\.us\/join\?confno=1/);
    assert.deepEqual([confirm.defaultId, confirm.cancelId], [1, 1], "Cancel is the default");
    await delay(100);
    assert.equal(externalOpens.length, 1, "a cancelled app link opens nothing");

    // A mailto: link inside a subframe reaches the policy through the openExternal permission.
    await firstPage.executeJavaScript(`new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.id = "embed";
      frame.allow = "display-capture; camera; microphone";
      frame.onload = () => resolve(true);
      frame.src = ${JSON.stringify(`${crossOrigin}/frame`)};
      document.body.append(frame);
    })`);
    const frame = await poll(() => embedFrame(), "cross-site frame");
    await frame.executeJavaScript("document.getElementById('mail').click()", true);
    await poll(() => externalOpens.includes("mailto:fixture@example.com"), "subframe mailto: opened through the policy");
  });
  // The preload now replaces the page's Notification API; the old postMessage channel is gone.
  await run("notifications from cross-site frames are dropped", async () => {
    const unseen = async () => (await getRuntime()).unseenNotificationCounts?.["account-a"] ?? 0;
    const before = await unseen();
    const embedded = await embedFrame().executeJavaScript(`new Promise((resolve) => {
      const notification = new Notification("Windows Security", { body: "Act now" });
      notification.onerror = () => resolve("error");
      notification.onshow = () => resolve("shown");
    })`, true);
    assert.equal(embedded, "error", "an embedded frame's notification fails in the page");
    await embedFrame().executeJavaScript(
      "window.top.postMessage({ source: 'comms-app-notification', payload: { title: 'Forged', body: 'Act now' } }, '*'); true"
    );
    await firstPage.executeJavaScript(
      "window.postMessage({ source: 'comms-app-notification', payload: { title: 'Forged', body: 'From the app' } }, '*'); true"
    );
    await delay(400);
    assert.equal(await unseen(), before, "an embedded frame cannot raise a notification for the service");
    await firstPage.executeJavaScript("new Notification('Real', { body: 'From the app' }); true", true);
    await poll(async () => (await unseen()) === before + 1, "the service's own page still notifies");
    await execute("window.commsApp.markNotificationsSeen('account-a')");
  });
  // The broker allows 5 screen requests per page per minute; this test and the next use all 5.
  await run("screen capture from other sites goes through the picker, which names them; a Block still refuses", async () => {
    const { getPermissionDecision, setPermissionDecision } = await import("../../electron/configStore.js");
    const shareFromFrame = (constraints = "{ video: true }") => embedFrame().executeJavaScript(
      `navigator.mediaDevices.getDisplayMedia(${constraints}).then(() => "shared", (error) => error.name)`, true
    );
    const prompts = dialogCalls.length;

    // No separate Allow/Block prompt: the picker itself says which site is asking.
    const asked = shareFromFrame();
    const picker = await poll(openPicker, "the in-app picker opens for the frame");
    assert.equal(picker.subtitle, "account-a wants to share your screen.");
    assert.equal(picker.origin, `Requested by ${crossOrigin}, which is not part of account-a's own site.`);
    await clickPickerButton("Cancel");
    // Cancel refuses the permission itself (as Chrome's picker does).
    assert.equal(await asked, "NotAllowedError");
    await poll(pickerClosed, "the picker closes on Cancel");
    assert.equal(dialogCalls.length, prompts, "no native prompt");
    assert.equal(getPermissionDecision("account-a", crossOrigin, "display-capture"), null, "nothing is remembered");

    // A Block remembered for that site (e.g. from an earlier version's prompt) refuses it outright.
    setPermissionDecision("account-a", crossOrigin, "display-capture", "block");
    const requests = sentCount(main, "screen-share:request");
    assert.equal(await shareFromFrame(), "NotAllowedError");
    assert.equal(
      await embedFrame().executeJavaScript(
        "navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } }).then(() => 'captured', (error) => error.name)", true
      ),
      "NotAllowedError",
      "legacy desktop capture constraints are refused too"
    );
    assert.equal(sentCount(main, "screen-share:request"), requests, "a remembered Block opens no picker");
    assert.equal(dialogCalls.length, prompts);
    setPermissionDecision("account-a", crossOrigin, "display-capture", null);

    // Legacy desktop constraints that skip the page's wrapper (here: from another script world)
    // still need a pick in the picker, even on the service's own site.
    const legacy = firstPage.executeJavaScriptInIsolatedWorld(4242, [{
      code: `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop" } } }).then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        return "captured";
      }, (error) => error.name)`
    }], true);
    const legacyPicker = await poll(openPicker, "the picker opens for legacy desktop constraints");
    assert.equal(legacyPicker.origin, null, "the service's own site is not called out");
    await clickPickerButton("Cancel");
    assert.equal(await legacy, "NotAllowedError", "nothing is captured without a pick");
    await poll(pickerClosed, "the picker closes");
    assert.equal(dialogCalls.length, prompts);

    // Checks agree with decisions for the service's own site.
    const cameraState = () => firstPage.executeJavaScript("navigator.permissions.query({ name: 'camera' }).then((status) => status.state)");
    assert.equal(await cameraState(), "granted");
    setPermissionDecision("account-a", origin, "camera", "block");
    assert.notEqual(await cameraState(), "granted", "a Block is never reported as granted");
    setPermissionDecision("account-a", origin, "camera", null);
    await firstPage.executeJavaScript("document.getElementById('embed').remove(); true");
  });
  await run("screen sharing always asks through the window's in-app picker", async () => {
    // The native-dialog fallback (a window without an in-app picker) is covered by tests/screen-share.test.mjs.
    const shareFromPage = (constraints) => firstPage.executeJavaScript(
      `navigator.mediaDevices.getDisplayMedia(${constraints}).then((stream) => {
        const kinds = stream.getTracks().map((track) => track.kind);
        stream.getTracks().forEach((track) => track.stop());
        return kinds;
      }, (error) => error.name)`, true
    );
    const pickerOpen = async () => Boolean(await openPicker());

    // The picker opens in the host window, hides the service, and pre-selects nothing; Cancel shares nothing.
    let prompts = dialogCalls.length;
    const cancelled = shareFromPage("{ video: true, audio: true }");
    await poll(pickerOpen, "the in-app picker opens");
    await poll(() => !attachedToMain(), "the service is hidden behind the picker");
    const picker = await execute(`(() => {
      const dialog = document.querySelector('.share-dialog');
      const share = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Share');
      return {
        title: dialog.querySelector('h2')?.textContent,
        subtitle: dialog.querySelector('.share-subtitle')?.textContent,
        shareDisabled: share.disabled,
        selected: dialog.querySelectorAll('.share-source.selected').length,
        audio: Boolean(dialog.querySelector('.share-footer input[type=checkbox]')),
        thumbnails: Array.from(dialog.querySelectorAll('.share-thumb img')).map((image) => image.getAttribute('src').slice(0, 23))
      };
    })()`);
    assert.equal(picker.title, "Choose what to share");
    assert.equal(picker.subtitle, "account-a wants to share your screen.");
    assert.equal(picker.shareDisabled, true, "Share waits for a choice");
    assert.equal(picker.selected, 0, "no source is pre-selected");
    assert.equal(picker.audio, process.platform === "win32", "system audio is offered only where loopback works");
    assert.ok(picker.thumbnails.every((source) => source === "data:image/jpeg;base64,"), "thumbnails are JPEG data URLs");
    await clickPickerButton("Cancel");
    // The pick is made at the permission step, so Cancel refuses the permission.
    assert.equal(await cancelled, "NotAllowedError");
    await poll(pickerClosed, "the picker closes on Cancel");
    await poll(() => attachedToMain(), "the service is shown again");
    assert.equal(dialogCalls.length, prompts, "the page's own site needs no prompt and no native dialog");

    // Choosing a screen and pressing Share shares it.
    const sharing = shareFromPage("{ video: true }");
    await poll(pickerOpen, "the picker opens again");
    const hasScreen = await execute("Boolean(document.querySelector('.share-dialog .share-source'))");
    if (hasScreen) {
      await execute("document.querySelector('.share-dialog .share-source').click(); true");
      await poll(() => execute("Array.from(document.querySelectorAll('.share-dialog button')).find((button) => button.textContent.trim() === 'Share')?.disabled === false"), "Share is enabled once a source is picked");
      await clickPickerButton("Share");
      assert.deepEqual(await sharing, ["video"], "the chosen screen is shared");
    } else {
      await clickPickerButton("Cancel");
      assert.equal(await sharing, "NotAllowedError", "no screen to share in this session");
    }
    await poll(pickerClosed, "the picker closes after Share");
    await poll(() => attachedToMain(), "the service is shown after sharing");

    // Navigating the page cancels its pending request and closes the picker.
    firstPage.executeJavaScript("navigator.mediaDevices.getDisplayMedia({ video: true }).catch(() => {})", true).catch(() => {});
    await poll(pickerOpen, "a third picker request");
    firstPage.reload();
    await poll(pickerClosed, "the picker closes when the page navigates");
    await poll(() => attachedToMain(), "the service is shown after the cancel");
    await pageReady();
  });
  await run("saving a service: main owns identity and session fields, and the address must be http(s)", async () => {
    const refused = await execute("window.commsApp.saveService({ name: 'Bad', url: 'javascript:alert(1)' }).then(() => 'saved', (error) => error.message)");
    assert.match(refused, /must start with https:\/\//);
    const state = await execute(`window.commsApp.saveService(${JSON.stringify({
      id: "hacker", name: "Evil", url: `${origin}/evil`, isBuiltIn: true, sessionPartition: "persist:account-a",
      useDefaultSession: true, userAgent: "Evil/1.0", iconSource: "file://attacker/share/x.png"
    })})`);
    const created = state.services.find((service) => service.name === "Evil");
    assert.ok(created && created.id !== "hacker", "main generates the id");
    assert.equal(created.isBuiltIn, false);
    assert.equal(created.sessionPartition, `persist:service-${created.id}`);
    assert.equal(created.useDefaultSession, false);
    assert.equal(created.userAgent, null);
    assert.match(created.iconSource, /^data:image\/svg\+xml/, "remote icon paths are replaced by the default icon");
    // Removing asks first (D7); answer "Remove".
    dialogAnswers.push({ response: 0, checkboxChecked: false });
    const removed = await execute(`window.commsApp.removeService(${JSON.stringify(created.id)})`);
    assert.equal(removed.services.some((service) => service.id === created.id), false);
    await execute("window.commsApp.setActiveService('account-a')");
    await poll(() => attachedToMain(), "account-a selected again");
    assert.equal(await getId("account-a"), firstId);
  });
  await run("shell windows stay on their own document and send links to the policy", async () => {
    const shellUrl = main.webContents.getURL();
    await execute(`location.href = ${JSON.stringify(`${origin}/account-a`)}; true`);
    await delay(400);
    assert.equal(main.webContents.getURL(), shellUrl, "the shell never navigates away");
    assert.equal((await getState()).ui.activeServiceId, "account-a", "the bridge still works");

    externalOpens.length = 0;
    const windowCount = BrowserWindow.getAllWindows().length;
    await execute("window.open('https://example.com/from-shell'); window.open('file:///C:/Windows/System32/calc.exe'); true");
    await poll(() => externalOpens.includes("https://example.com/from-shell"), "shell link opened in the browser");
    await delay(100);
    assert.deepEqual(externalOpens, ["https://example.com/from-shell"]);
    assert.equal(BrowserWindow.getAllWindows().length, windowCount, "no window was created");
  });
  await run("a crashed shell renderer is reloaded and the app pages survive it", async () => {
    const gone = new Promise((resolve) => main.webContents.once("render-process-gone", resolve));
    main.webContents.forcefullyCrashRenderer();
    await gone;
    await poll(() => !main.webContents.isCrashed() &&
      execute("document.readyState === 'complete' && Boolean(window.commsApp && document.querySelector('.service-viewport'))"),
      "the main window's page is loaded again", 15000);
    assert.equal((await getState()).ui.activeServiceId, "account-a", "the bridge works again");
    await poll(() => attachedToMain(), "the selected page is shown again");
    assert.equal(await getId("account-a"), firstId, "the app pages were not reloaded");
  });
  await run("update downloads open only this repository's release pages", async () => {
    const realFetch = globalThis.fetch;
    const releaseUrl = "https://github.com/ZevosSky/personal-comms-hub/releases/tag/v999.0.0";
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      tag_name: "v999.0.0", html_url: releaseUrl,
      assets: [{ name: "Comms-Hub-Setup-999.0.0.exe", browser_download_url: "file:///C:/Windows/System32/calc.exe" }]
    }) });
    try {
      externalOpens.length = 0;
      assert.equal((await execute("window.commsApp.checkForUpdates()")).status, "update-available");
      assert.equal(await execute("window.commsApp.openUpdateDownload()"), true);
      assert.deepEqual(externalOpens, [releaseUrl], "the file: asset URL is ignored");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  await run("a page notification raises one labelled toast; its click selects the app, reveals it and reaches the page", async () => {
    const original = (await getState()).services.find((service) => service.id === "account-b");
    await execute("window.commsApp.setNotificationsEnabled(false)");
    await execute(`window.commsApp.saveService(${JSON.stringify({
      ...original, notificationSettings: { ...original.notificationSettings, desktopEnabled: false }
    })})`);
    const secondPage = webContents.fromId(await getId("account-b"));
    await poll(() => secondPage.executeJavaScript("document.readyState === 'complete' && Boolean(window.__commsNotificationBridgeInstalled)"), "account-b ready");
    await secondPage.executeJavaScript(`window.__clicks = 0; window.__raise = (title) => {
      const notification = new Notification(title, { body: "Body of " + title });
      notification.onclick = () => { window.__clicks += 1; };
    }; true`);
    const unseen = async () => (await getRuntime()).unseenNotificationCounts?.["account-b"] ?? 0;
    const toastCount = toasts.length;
    assert.equal(await unseen(), 0);

    // Alerts are off: the notification is counted but no toast is shown.
    await secondPage.executeJavaScript("window.__raise('While muted'); true", true);
    await poll(async () => (await unseen()) === 1, "a muted notification is still counted");
    await execute("window.commsApp.setNotificationsEnabled(true)");
    await secondPage.executeJavaScript("window.__raise('Desktop alerts off'); true", true);
    await poll(async () => (await unseen()) === 2, "counted while the app's desktop alerts are off");
    await delay(100);
    assert.equal(toasts.length, toastCount, "no toast unless global and per-app alerts are on");

    const accountB = (await getState()).services.find((service) => service.id === "account-b");
    await execute(`window.commsApp.saveService(${JSON.stringify({
      ...accountB, notificationSettings: { ...accountB.notificationSettings, desktopEnabled: true }
    })})`);
    await secondPage.executeJavaScript("window.__raise('Lunch?'); true", true);
    const toast = await poll(() => toasts.length > toastCount && toasts.at(-1), "a toast for the page notification");
    assert.equal(toast.title, "account-b: Lunch?");
    assert.equal(toast.body, "Body of Lunch?");
    await delay(150);
    assert.equal(toasts.length, toastCount + 1, "exactly one toast per page notification");

    main.hide();
    toast.emit("click");
    await poll(() => main.isVisible(), "the click reveals the app");
    await poll(async () => (await getState()).ui.activeServiceId === "account-b", "the click selects the app");
    await poll(() => secondPage.executeJavaScript("window.__clicks === 1"), "the click reaches the page's onclick");
    await poll(async () => (await unseen()) === 0, "opening the app marks its notifications seen");

    await execute(`window.commsApp.saveService(${JSON.stringify(original)})`);
    await execute("window.commsApp.setNotificationsEnabled(false)");
    await execute("window.commsApp.setActiveService('account-a')");
    await poll(() => attachedToMain(), "account-a selected again");
  });
  await run("title unread counts feed runtime badges and the tray tooltip", async () => {
    const secondPage = webContents.fromId(await getId("account-b"));
    const badge = async () => (await getRuntime()).badgeCounts?.["account-b"];
    assert.equal(await badge(), 0);
    await secondPage.executeJavaScript("document.title = '(3) Inbox'; true");
    await poll(async () => (await badge()) === 3, "title count reaches runtime");
    await poll(() => trayState.toolTip === "Comms Hub - 3 unread", "tray tooltip counts title unread");
    await secondPage.executeJavaScript("document.title = 'Bob messaged you'; true");
    await delay(200);
    assert.equal(await badge(), 3, "a flashing title keeps the last count");
    await secondPage.executeJavaScript("document.title = 'Inbox'; true");
    await poll(async () => (await badge()) === 0, "count cleared when the title drops it");
    await poll(() => trayState.toolTip === "Comms Hub", "tooltip cleared");
  });
  await run("memory readout per app, and sleep now keeps a pinned app asleep until it is selected", async () => {
    const metrics = await execute("window.commsApp.getServiceMetrics()");
    assert.ok(Number.isFinite(metrics.sampledAt));
    assert.ok(metrics.shellMemoryKB > 0 && metrics.totalMemoryKB >= metrics.shellMemoryKB);
    for (const id of ["account-a", "account-b"]) {
      const entry = metrics.services[id];
      assert.ok(entry && entry.memoryKB > 0 && entry.processCount >= 1, `${id} reports its renderer`);
      assert.equal(typeof entry.cpuPercent, "number");
      assert.equal(typeof entry.shared, "boolean");
    }

    assert.equal(await execute("window.commsApp.sleepService('account-a')"), false, "the selected app is never put to sleep");
    assert.equal(await execute("window.commsApp.sleepService('missing')"), false);
    const pinnedId = await getId("account-b");
    assert.equal(await execute("window.commsApp.sleepService('account-b')"), true);
    await poll(() => !webContents.fromId(pinnedId) || webContents.fromId(pinnedId).isDestroyed(), "the pinned app's page closed");
    await poll(async () => (await getRuntime()).services["account-b"].status === "sleeping", "reported as sleeping");
    await delay(400);
    const asleep = (await getRuntime()).services["account-b"];
    assert.equal(asleep.webContentsId, null, "a pinned app put to sleep is not reloaded");
    assert.equal(asleep.manuallySlept, true);
    assert.equal((await execute("window.commsApp.getServiceMetrics()")).services["account-b"], undefined);

    await execute("window.commsApp.setActiveService('account-b')");
    await poll(async () => (await getRuntime()).services["account-b"].status === "active", "selecting the app wakes it");
    assert.equal((await getRuntime()).services["account-b"].manuallySlept, false);
    await execute("window.commsApp.setActiveService('account-a')");
    await poll(() => attachedToMain(), "account-a selected again");
    assert.equal(await getId("account-a"), firstId);
    assert.ok(await getId("account-b"), "pinned again once woken");
  });
  await run("the taskbar badge takes a small PNG and clears with null", async () => {
    const { getAppIcon } = await import("../../electron/appIcon.js");
    const png = getAppIcon().resize({ width: 16, height: 16 }).toDataURL();
    const overlays = [];
    const setOverlayIcon = main.setOverlayIcon;
    main.setOverlayIcon = function patched(image, description) {
      overlays.push({ empty: image ? image.isEmpty() : null, description });
      return setOverlayIcon.call(this, image, description);
    };
    try {
      const set = (badge) => execute(`window.commsApp.setOverlayBadge(${JSON.stringify(badge)})`);
      assert.equal(await set({ count: 1, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }), false, "only PNG");
      assert.equal(await set({ count: 1, dataUrl: `data:image/png;base64,${"A".repeat(70000)}` }), false, "at most 64 KB");
      assert.equal(await set("3"), false);
      if (process.platform === "win32") {
        assert.equal(await set({ count: 2, dataUrl: png }), true);
        assert.deepEqual(overlays.at(-1), { empty: false, description: "2 unread" });
        assert.equal(await set(null), true);
        assert.deepEqual(overlays.at(-1), { empty: null, description: "" });
      } else {
        assert.equal(typeof await set({ count: 2, dataUrl: png }), "boolean");
        assert.equal(overlays.length, 0, "only Windows has a taskbar overlay");
        await set(null);
      }
    } finally {
      main.setOverlayIcon = setOverlayIcon;
    }
  });
  // Guest UX (M4). Keys are synthesized with sendInputEvent, which goes through before-input-event.
  const press = (contents, keyCode, modifiers = []) => {
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  const activeId = async () => (await getState()).ui.activeServiceId;
  const zoomOf = async (id) => (await getState()).services.find((service) => service.id === id).zoomFactor;
  await run("guests get a clean Chrome user agent", async () => {
    const userAgent = await firstPage.executeJavaScript("navigator.userAgent");
    assert.doesNotMatch(userAgent, /Electron|comms-app|Comms Hub/i);
    assert.match(userAgent, new RegExp(`Chrome/${process.versions.chrome.split(".")[0]}\\.0\\.0\\.0 `));
  });
  await run("no default menu; shortcuts drive the selected app from the page and the shell, and Ctrl+W closes nothing", async () => {
    if (process.platform !== "darwin") assert.equal(Menu.getApplicationMenu(), null, "Electron's default menu is gone (D12)");
    press(firstPage, "2", ["control"]);
    await poll(async () => (await activeId()) === "account-b", "Ctrl+2 in the page selects the second app");
    press(main.webContents, "Tab", ["control"]);
    await poll(async () => (await activeId()) === "account-a", "Ctrl+Tab in the shell wraps to the first app");
    press(main.webContents, "PageUp", ["control"]);
    await poll(async () => (await activeId()) === "account-b", "Ctrl+PageUp goes to the previous app");
    press(main.webContents, "PageDown", ["control"]);
    await poll(async () => (await activeId()) === "account-a", "Ctrl+PageDown goes to the next app");
    await poll(() => attachedToMain(), "account-a shown again");

    const startZoom = await zoomOf("account-a");
    press(firstPage, "=", ["control"]);
    await poll(async () => Math.abs((await zoomOf("account-a")) - Math.min(2, startZoom + 0.1)) < 1e-9, "Ctrl+= zooms in and is saved");
    await poll(() => Math.abs(firstPage.getZoomFactor() - Math.min(2, startZoom + 0.1)) < 1e-6, "the page follows");
    press(firstPage, "0", ["control"]);
    await poll(async () => (await zoomOf("account-a")) === 1, "Ctrl+0 resets the zoom");

    await pageReady();
    await firstPage.executeJavaScript("window.__marker = 1; true");
    press(firstPage, "R", ["control"]);
    await poll(() => firstPage.executeJavaScript("window.__marker === undefined && document.readyState === 'complete'"), "Ctrl+R reloads the app");

    await execute("window.__findRequests = []; window.__offFindRequested = window.commsApp.onFindRequested((request) => window.__findRequests.push(request)); true");
    // Windows stay hidden here, so focus is read from the documents (webContents.isFocused() is false for both).
    firstPage.focus();
    await poll(() => firstPage.executeJavaScript("document.hasFocus()"), "the page has the keyboard");
    press(firstPage, "F", ["control"]);
    const findRequest = await poll(() => execute("window.__findRequests[0] ?? null"), "Ctrl+F asks the host window for its find bar");
    assert.equal(findRequest.serviceId, "account-a");
    await execute("window.__offFindRequested(); true");
    // The find bar takes the keyboard from the page, so typing never reaches the page (or its chat box).
    await poll(() => execute("document.hasFocus() && document.activeElement?.classList.contains('find-input') === true"),
      "the find input has the keyboard");
    assert.equal(await firstPage.executeJavaScript("document.hasFocus()"), false, "the page no longer has the keyboard");
    // Closing the bar gives the keyboard back to the page.
    press(main.webContents, "Escape");
    await poll(() => execute("!document.querySelector('.find-input')"), "Escape closes the find bar");
    await poll(() => firstPage.executeJavaScript("document.hasFocus()"), "the page has the keyboard again");
    assert.equal(await execute("document.hasFocus()"), false);

    const collapsed = (await getState()).ui.sidebarCollapsed;
    press(main.webContents, ",", ["control"]);
    await poll(async () => (await getState()).ui.sidebarCollapsed === !collapsed, "Ctrl+, toggles the settings sidebar");
    press(main.webContents, ",", ["control"]);
    await poll(async () => (await getState()).ui.sidebarCollapsed === collapsed, "and back");

    const devTools = [];
    firstPage.isDevToolsOpened = () => false;
    firstPage.openDevTools = (options) => { devTools.push(options); };
    try {
      press(main.webContents, "F12");
      await poll(() => devTools.length === 1, "F12 opens DevTools for the selected app");
      assert.deepEqual(devTools[0], { mode: "detach" });
    } finally {
      delete firstPage.isDevToolsOpened;
      delete firstPage.openDevTools;
    }

    const quit = app.quit;
    let quits = 0;
    app.quit = () => { quits += 1; };
    const windowCount = BrowserWindow.getAllWindows().length;
    try {
      press(firstPage, "W", ["control"]);
      press(main.webContents, "W", ["control"]);
      await delay(300);
    } finally {
      app.quit = quit;
    }
    assert.equal(quits, 0, "Ctrl+W never quits");
    assert.equal(BrowserWindow.getAllWindows().length, windowCount, "Ctrl+W closes no window");
    assert.equal(firstPage.isDestroyed(), false);
    assert.equal(await getId("account-a"), firstId);
  });
  await run("back, forward, home and open in browser drive the selected app", async () => {
    const home = `${origin}/account-a`;
    const next = `${origin}/account-a/next`;
    await poll(() => firstPage.getURL() === home, "account-a is on its home page");
    await firstPage.loadURL(next);
    await poll(async () => (await getRuntime()).services["account-a"].canGoBack === true, "runtime reports canGoBack");
    press(firstPage, "Left", ["alt"]);
    await poll(() => firstPage.getURL() === home, "Alt+Left goes back");
    main.emit("app-command", {}, "browser-forward");
    await poll(() => firstPage.getURL() === next, "the mouse forward button goes forward");
    assert.equal(await execute("window.commsApp.navigateActive('back')"), true);
    await poll(() => firstPage.getURL() === home, "navigateActive('back')");
    assert.equal(await execute("window.commsApp.navigateActive('forward')"), true);
    await poll(() => firstPage.getURL() === next, "navigateActive('forward')");
    externalOpens.length = 0;
    assert.equal(await execute("window.commsApp.navigateActive('open-in-browser')"), true);
    assert.deepEqual(externalOpens, [next], "the current page goes to the browser");
    assert.equal(await execute("window.commsApp.navigateActive('home')"), true);
    await poll(() => firstPage.getURL() === home, "navigateActive('home') returns to the app's address");
    assert.equal(await execute("window.commsApp.navigateActive('elsewhere')"), false);
    await pageReady();
  });
  await run("find in page reports matches to the window that asked", async () => {
    await execute("window.__findResults = []; window.__offFindResult = window.commsApp.onFindResult((result) => window.__findResults.push(result)); true");
    const requestId = await execute("window.commsApp.findInPage('Account')");
    assert.equal(typeof requestId, "number");
    const result = await poll(
      () => execute(`window.__findResults.find((result) => result.requestId === ${requestId} && result.finalUpdate) ?? null`),
      "find result"
    );
    assert.ok(result.matches >= 1, `matches: ${JSON.stringify(result)}`);
    assert.ok(result.activeMatchOrdinal >= 1);
    const nextId = await execute("window.commsApp.findInPage('Account', { findNext: true })");
    assert.equal(typeof nextId, "number");
    assert.notEqual(nextId, requestId);
    assert.equal(await execute("window.commsApp.findInPage('')"), null, "nothing to search");
    assert.equal(await execute("window.commsApp.stopFindInPage()"), true);
    await execute("window.__offFindResult(); true");
  });
  await run("right-click menus: the page menu follows what was clicked; the rail menu manages the app", async () => {
    menuPopups.length = 0;
    // Synthesized mouse input does not open menus in hidden windows, so Electron's event is emitted.
    const plain = { x: 4, y: 4, isEditable: false, selectionText: "", linkURL: "", mediaType: "none", editFlags: {} };
    firstPage.emit("context-menu", { preventDefault() {} }, plain);
    const pagePopup = await poll(() => menuPopups.at(-1), "page menu");
    assert.equal(pagePopup.options.window, main, "popped on the window hosting the app");
    assert.deepEqual(menuLabels(pagePopup.menu), ["Back", "Forward", "Reload", "Open page in browser", "Inspect"]);
    assert.equal(menuItem(pagePopup.menu, "Back").enabled, true, "account-a has history");

    const editable = {
      x: 5, y: 5, isEditable: true, misspelledWord: "helo", dictionarySuggestions: ["hello", "help"], selectionText: "",
      linkURL: "", mediaType: "none", editFlags: { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    };
    firstPage.emit("context-menu", { preventDefault() {} }, editable);
    const editMenu = menuPopups.at(-1).menu;
    assert.deepEqual(menuLabels(editMenu).slice(0, 3), ["hello", "help", "Add to dictionary"]);
    assert.ok(menuLabels(editMenu).includes("Paste as plain text"));
    assert.equal(menuItem(editMenu, "Undo").enabled, false);

    firstPage.emit("context-menu", { preventDefault() {} }, { x: 5, y: 5, isEditable: false, selectionText: "", mediaType: "none", editFlags: {}, linkURL: "https://example.net/doc" });
    externalOpens.length = 0;
    menuItem(menuPopups.at(-1).menu, "Open link in browser").click();
    await poll(() => externalOpens.includes("https://example.net/doc"), "link opened through the link policy");

    // The rail menu for a background app.
    assert.equal(await execute("window.commsApp.showServiceContextMenu('account-b')"), true);
    const rail = menuPopups.at(-1);
    assert.equal(rail.options.window, main);
    assert.deepEqual(menuLabels(rail.menu), ["Reload", "Sleep now", "Keep alive", "Desktop alerts", "Edit…", "Open in browser", "Remove…"]);
    assert.equal(menuItem(rail.menu, "Keep alive").checked, true);
    assert.equal(menuItem(rail.menu, "Desktop alerts").checked, true, "v1 Desktop alerts off with capture on migrates to on");
    assert.equal(menuItem(rail.menu, "Sleep now").enabled, true);
    menuItem(rail.menu, "Keep alive").click();
    await poll(async () => (await getState()).services.find((service) => service.id === "account-b").keepAliveInBackground === false, "Keep alive unchecked");
    await execute("window.__edits = []; window.__offEdit = window.commsApp.onEditServiceRequested((request) => window.__edits.push(request)); true");
    menuItem(rail.menu, "Edit…").click();
    assert.deepEqual(await poll(() => execute("window.__edits[0] ?? null"), "edit requested"), { serviceId: "account-b" });
    await execute("window.__offEdit(); true");
    // The shell opens that app's settings dialog, which hides the native page until it closes.
    await poll(() => execute("document.querySelector('.modal')?.querySelector('input')?.value === 'account-b'"), "the rail menu opens account-b's settings");
    await poll(() => !attachedToMain(), "the page is hidden behind the dialog");
    await execute("document.querySelector('.modal .ghost-button').click(); true");
    await poll(() => execute("!document.querySelector('.modal-backdrop')"), "the dialog closes");
    await poll(() => attachedToMain(), "the selected page is shown again");
    await execute("window.commsApp.showServiceContextMenu('account-b')");
    const again = menuPopups.at(-1).menu;
    assert.equal(menuItem(again, "Keep alive").checked, false, "the menu shows fresh state");
    menuItem(again, "Keep alive").click();
    await poll(async () => (await getState()).services.find((service) => service.id === "account-b").keepAliveInBackground === true, "Keep alive restored");
    assert.equal(await execute("window.commsApp.showServiceContextMenu('missing')"), false);

    // Remembered camera/mic/screen answers can be reset from the rail menu.
    const { getPermissionDecision, setPermissionDecision } = await import("../../electron/configStore.js");
    assert.equal(setPermissionDecision("account-b", "https://meet.example", "camera", "block"), true);
    await execute("window.__status = []; window.__offStatus = window.commsApp.onStatusMessage((message) => window.__status.push(message)); true");
    await execute("window.commsApp.showServiceContextMenu('account-b')");
    const withDecisions = menuPopups.at(-1).menu;
    assert.ok(menuLabels(withDecisions).includes("Reset site permissions"));
    menuItem(withDecisions, "Reset site permissions").click();
    const status = await poll(() => execute("window.__status.at(-1) ?? null"), "reset status message");
    assert.equal(getPermissionDecision("account-b", "https://meet.example", "camera"), null);
    assert.equal(status.tone, "info");
    assert.match(status.text, /^Reset site permissions for account-b\./);
    await execute("window.__offStatus(); true");
    await execute("window.commsApp.showServiceContextMenu('account-b')");
    assert.equal(menuLabels(menuPopups.at(-1).menu).includes("Reset site permissions"), false, "hidden once nothing is remembered");
  });
  await run("popups: same-origin pages open as child windows with the session; other sites go to the browser", async () => {
    const accountB = (await getState()).services.find((service) => service.id === "account-b");
    await execute(`window.commsApp.saveService(${JSON.stringify({ ...accountB, keepAliveInBackground: false })})`);
    const secondPage = webContents.fromId(await getId("account-b"));
    await poll(() => secondPage.executeJavaScript("document.readyState === 'complete'"), "account-b ready");
    const pageUrl = secondPage.getURL();
    await secondPage.executeJavaScript("document.cookie = 'account=B'; true");
    const windowCount = BrowserWindow.getAllWindows().length;
    await secondPage.executeJavaScript("window.__popup = window.open('/account-b/popup', 'pop', 'width=480,height=600'); true", true);
    const popup = await poll(
      () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes("/account-b/popup")),
      "child window"
    );
    await poll(() => popup.webContents.executeJavaScript("document.readyState === 'complete'"), "popup loaded");
    assert.equal(await popup.webContents.executeJavaScript("Boolean(window.opener)"), true, "window.opener survives");
    assert.match(await popup.webContents.executeJavaScript("document.cookie"), /account=B/, "the popup shares the app's session");
    assert.doesNotMatch(await popup.webContents.executeJavaScript("navigator.userAgent"), /Electron/);
    await poll(() => popup.isVisible(), "the popup is shown once it has painted");
    await poll(async () => (await getRuntime()).services["account-b"].protectionReason === "popup", "an open popup keeps its app awake");
    assert.equal(secondPage.getURL(), pageUrl, "the app's own page was not replaced");

    externalOpens.length = 0;
    await secondPage.executeJavaScript(`window.open(${JSON.stringify(`${crossOrigin}/elsewhere`)}); true`, true);
    await poll(() => externalOpens.includes(`${crossOrigin}/elsewhere`), "another site goes to the browser");
    assert.equal(BrowserWindow.getAllWindows().length, windowCount + 1, "only the same-origin popup became a window");

    // window.open() then location = link: an outside link goes to the browser and the blank window closes.
    await secondPage.executeJavaScript(`(() => { const w = window.open(); w.opener = null; w.location = ${JSON.stringify(`${crossOrigin}/via-blank`)}; return true; })()`, true);
    await poll(() => externalOpens.includes(`${crossOrigin}/via-blank`), "a blank window sent elsewhere goes to the browser");
    await poll(() => BrowserWindow.getAllWindows().length === windowCount + 1, "the blank window closes");
    // A pop-out filled in by the app itself (Gmail's compose window) stays a child window.
    await secondPage.executeJavaScript("window.__blank = window.open('', 'compose'); window.__blank.location = '/account-b/compose'; true", true);
    const compose = await poll(
      () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes("/account-b/compose")),
      "same-origin pop-out"
    );
    assert.ok(!externalOpens.some((url) => url.includes("/account-b/compose")));
    compose.close();
    await poll(() => compose.isDestroyed(), "pop-out closed");

    popup.close();
    await poll(() => popup.isDestroyed(), "popup closed");
    await poll(async () => (await getRuntime()).services["account-b"].protectionReason !== "popup", "closing the popup releases its app");
    await execute(`window.commsApp.saveService(${JSON.stringify(accountB)})`);
  });
  await run("a popup's notifications take the app's path: counted, one labelled toast, none while alerts are off", async () => {
    const accountB = (await getState()).services.find((service) => service.id === "account-b");
    const secondPage = webContents.fromId(await getId("account-b"));
    await poll(() => secondPage.executeJavaScript("document.readyState === 'complete'"), "account-b ready");
    await secondPage.executeJavaScript("window.open('/account-b/notify-popup', 'notify', 'width=480,height=600'); true", true);
    const popup = await poll(
      () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes("/account-b/notify-popup")),
      "notifying popup"
    );
    await poll(
      () => popup.webContents.executeJavaScript("document.readyState === 'complete' && Boolean(window.__commsNotificationBridgeInstalled)"),
      "the popup has the guest preload's notification bridge"
    );
    assert.equal(await popup.webContents.executeJavaScript("Function.prototype.toString.call(Notification).includes('[native code]')"), false,
      "the popup's Notification is the bridge, not the native API");
    await popup.webContents.executeJavaScript(`window.__clicks = 0; window.__raise = (title) => {
      const notification = new Notification(title, { body: "Body of " + title });
      notification.onclick = () => { window.__clicks += 1; };
    }; true`);
    const unseen = async () => (await getRuntime()).unseenNotificationCounts?.["account-b"] ?? 0;
    const unseenBefore = await unseen();
    const toastCount = toasts.length;

    // Alerts are off: counted for the app that opened the popup, but no toast.
    await execute("window.commsApp.setNotificationsEnabled(false)");
    await popup.webContents.executeJavaScript("window.__raise('Popup while muted'); true", true);
    await poll(async () => (await unseen()) === unseenBefore + 1, "a popup notification is counted for its app");
    await delay(100);
    assert.equal(toasts.length, toastCount, "no toast while alerts are off");

    await execute("window.commsApp.setNotificationsEnabled(true)");
    await execute(`window.commsApp.saveService(${JSON.stringify({
      ...accountB, notificationSettings: { ...accountB.notificationSettings, desktopEnabled: true }
    })})`);
    await popup.webContents.executeJavaScript("window.__raise('From the popup'); true", true);
    const toast = await poll(() => toasts.length > toastCount && toasts.at(-1), "a toast for the popup notification");
    assert.equal(toast.title, "account-b: From the popup");
    assert.equal(toast.body, "Body of From the popup");
    await delay(150);
    assert.equal(toasts.length, toastCount + 1, "exactly one toast per popup notification");
    popup.hide();
    toast.emit("click");
    await poll(async () => (await getState()).ui.activeServiceId === "account-b", "the click selects the popup's app");
    await poll(() => popup.isVisible(), "the click brings the popup forward");
    await poll(() => popup.webContents.executeJavaScript("window.__clicks === 1"), "the click reaches the popup's onclick");

    await execute(`window.commsApp.saveService(${JSON.stringify(accountB)})`);
    await execute("window.commsApp.setNotificationsEnabled(false)");
    await execute("window.commsApp.markNotificationsSeen('account-b')");
    await execute("window.commsApp.setActiveService('account-a')");
    await poll(() => attachedToMain(), "account-a selected again");
    popup.close();
    await poll(() => popup.isDestroyed(), "notifying popup closed");
    await poll(async () => (await getRuntime()).services["account-b"].protectionReason !== "popup", "closing the popup releases its app");
  });
  await run("popups: a navigation the opener starts is re-checked; other sites in a popup still ask before capture", async () => {
    const secondPage = webContents.fromId(await getId("account-b"));
    await poll(() => secondPage.executeJavaScript("document.readyState === 'complete'"), "account-b ready");
    const popupAt = (marker) => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes(marker));
    const loaded = (window) => window.webContents.executeJavaScript("document.readyState === 'complete'");

    // The opener sends its open same-origin popup to another site: the link goes to the browser and the popup closes.
    await secondPage.executeJavaScript("window.__pushed = window.open('/account-b/pushed', 'pushed', 'width=480,height=600'); true", true);
    const pushed = await poll(() => popupAt("/account-b/pushed"), "same-origin popup");
    await poll(() => loaded(pushed), "popup loaded");
    externalOpens.length = 0;
    await secondPage.executeJavaScript(`window.__pushed.location = ${JSON.stringify(`${crossOrigin}/pushed-away`)}; true`, true);
    await poll(() => externalOpens.includes(`${crossOrigin}/pushed-away`), "the opener's off-site navigation goes to the browser");
    await poll(() => pushed.isDestroyed(), "the popup closes");

    // A link followed inside the popup stays there, but that site still has to ask before capturing.
    await secondPage.executeJavaScript("window.open('/account-b/linked', 'linked', 'width=480,height=600'); true", true);
    const linked = await poll(() => popupAt("/account-b/linked"), "second popup");
    await poll(() => loaded(linked), "second popup loaded");
    await linked.webContents.executeJavaScript(`location.href = ${JSON.stringify(`${crossOrigin}/in-popup`)}; true`, true);
    await poll(() => linked.webContents.getURL().startsWith(`${crossOrigin}/in-popup`) && loaded(linked), "the popup's own link stays in the popup");
    const prompts = dialogCalls.length;
    // Screen capture from another site in the popup opens the picker, which names that site.
    const captured = linked.webContents.executeJavaScript(
      "navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'shared', (error) => error.name)", true
    );
    const picker = await poll(openPicker, "the picker opens for the popup's page");
    assert.equal(picker.subtitle, "account-b wants to share your screen.");
    assert.equal(picker.origin, `Requested by ${crossOrigin}, which is not part of account-b's own site.`);
    await clickPickerButton("Cancel");
    assert.equal(await captured, "NotAllowedError", "Cancel denies it");
    await poll(pickerClosed, "the picker closes");
    assert.equal(dialogCalls.length, prompts, "the picker asks; no separate prompt");
    linked.close();
    await poll(() => linked.isDestroyed(), "second popup closed");
    await poll(async () => (await getRuntime()).services["account-b"].protectionReason !== "popup", "closing the popups releases the app");
  });
  await run("popups: the app sets the window chrome, at most five per app, and only its own frames fill a blank window", async () => {
    await pageReady();
    const popupAt = (marker) => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes(marker));
    const windowCount = BrowserWindow.getAllWindows().length;
    // 2 px of slack for DIP rounding on scaled displays.
    const inside = (bounds, area) => bounds.x >= area.x - 2 && bounds.y >= area.y - 2 &&
      bounds.x + bounds.width <= area.x + area.width + 2 && bounds.y + bounds.height <= area.y + area.height + 2;
    const onScreen = (bounds) => screen.getAllDisplays().some(({ workArea }) => inside(bounds, workArea));

    // Window chrome asked for in the window.open() features is ignored and the window lands on screen.
    const features = "frame=no,transparent=yes,alwaysOnTop=yes,fullscreen=yes,kiosk=yes,closable=no,minimizable=no,movable=no," +
      "resizable=no,skipTaskbar=yes,opacity=0.1,type=toolbar,left=-5000,top=-5000,width=9000,height=9000";
    await firstPage.executeJavaScript(`window.open('/account-a/chrome', 'chrome', ${JSON.stringify(features)}); true`, true);
    const chrome = await poll(() => popupAt("/account-a/chrome"), "popup asking for window chrome");
    assert.equal(chrome.isAlwaysOnTop(), false);
    assert.equal(chrome.isFullScreen(), false);
    assert.equal(chrome.isKiosk(), false);
    assert.equal(chrome.isClosable(), true);
    assert.equal(chrome.isMinimizable(), true);
    assert.equal(chrome.isMovable(), true);
    assert.equal(chrome.isResizable(), true);
    assert.equal(chrome.getOpacity(), 1);
    assert.ok(chrome.getContentBounds().height < chrome.getBounds().height, "the popup has a frame");
    assert.ok(onScreen(chrome.getBounds()), `inside a work area: ${JSON.stringify(chrome.getBounds())}`);
    await poll(() => chrome.webContents.executeJavaScript("document.readyState === 'complete'"), "chrome popup loaded");
    await chrome.webContents.executeJavaScript("window.moveTo(-6000, -6000); window.resizeTo(9000, 9000); true", true);
    await delay(200);
    assert.ok(onScreen(chrome.getBounds()), `moveTo/resizeTo stay on screen: ${JSON.stringify(chrome.getBounds())}`);
    chrome.close();
    await poll(() => chrome.isDestroyed(), "chrome popup closed");

    // Five popups per app: past that a page goes to the browser and a blank window is refused.
    await firstPage.executeJavaScript("window.__capped = [1, 2, 3, 4, 5].map((n) => window.open('/account-a/cap-' + n, 'cap-' + n)); true", true);
    const capped = await poll(() => {
      const list = [1, 2, 3, 4, 5].map((n) => popupAt(`/account-a/cap-${n}`));
      return list.every(Boolean) && list;
    }, "five popups");
    externalOpens.length = 0;
    assert.equal(await firstPage.executeJavaScript("window.open('/account-a/cap-6', 'cap-6') === null && window.open('') === null", true), true,
      "no sixth window opens");
    await poll(() => externalOpens.some((url) => url.endsWith("/account-a/cap-6")), "a sixth popup goes to the browser");
    await delay(100);
    assert.equal(externalOpens.length, 1, "the refused blank window opens nothing");
    for (const window of capped) window.close();
    await poll(() => capped.every((window) => window.isDestroyed()), "capped popups closed");

    // A blank window an embed fills in is closed; one the app's own page fills in stays.
    await firstPage.executeJavaScript(`new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.id = "popup-embed";
      frame.onload = () => resolve(true);
      frame.src = ${JSON.stringify(`${crossOrigin}/frame-popup`)};
      document.body.append(frame);
    })`);
    const embed = await poll(() => firstPage.mainFrame.frames.find((frame) => frame.url === `${crossOrigin}/frame-popup`), "embed");
    assert.equal(await embed.executeJavaScript(`(() => {
      window.__spoof = window.open('');
      try { window.__spoof.document.write('<title>Spoof</title><h1>Sign in</h1>'); } catch {}
      return Boolean(window.__spoof);
    })()`, true), true);
    await poll(() => embed.executeJavaScript("window.__spoof.closed"), "a blank window filled by an embed closes");
    await firstPage.executeJavaScript("window.__own = window.open(''); window.__own.document.write('<title>Own pop-out</title><p>Draft</p>'); true", true);
    const own = await poll(
      () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getTitle() === "Own pop-out"),
      "the app's own blank pop-out"
    );
    await delay(200);
    assert.equal(own.isDestroyed(), false, "the app's own blank pop-out stays open");
    assert.equal(await firstPage.executeJavaScript("window.__own.closed"), false);
    own.close();
    await poll(() => own.isDestroyed(), "own pop-out closed");
    await firstPage.executeJavaScript("document.getElementById('popup-embed').remove(); true");
    await poll(() => BrowserWindow.getAllWindows().length === windowCount, "no popup windows left");
  });
  await run("sleep now asks before closing an app's pop-out windows; one that won't close keeps the app awake", async () => {
    const secondPage = webContents.fromId(await getId("account-b"));
    await poll(() => secondPage.executeJavaScript("document.readyState === 'complete'"), "account-b ready");
    await secondPage.executeJavaScript("window.open('/account-b/sleepy', 'sleepy', 'width=480,height=600'); true", true);
    const sleepy = await poll(
      () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.getURL().includes("/account-b/sleepy")),
      "account-b pop-out"
    );
    await poll(() => sleepy.webContents.executeJavaScript("document.readyState === 'complete'"), "pop-out loaded");

    // No: nothing closes and the app stays awake.
    const prompts = dialogCalls.length;
    assert.equal(await execute("window.commsApp.sleepService('account-b')"), null, "the user said no");
    assert.equal(dialogCalls.length, prompts + 1);
    const ask = dialogCalls.at(-1);
    assert.equal(ask.message, "Close account-b's open window and put it to sleep?");
    assert.deepEqual([ask.defaultId, ask.cancelId], [1, 1], "Cancel is the default");
    assert.equal(sleepy.isDestroyed(), false);
    assert.ok((await getRuntime()).services["account-b"].webContentsId, "still awake");

    // Yes, but the pop-out's page keeps it open (beforeunload): the app stays awake.
    await sleepy.webContents.executeJavaScript(
      "window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = 'Unsent'; return 'Unsent'; }; true", true);
    dialogAnswers.push({ response: 0 });
    assert.equal(await execute("window.commsApp.sleepService('account-b')"), false, "the pop-out stayed open");
    assert.equal(sleepy.isDestroyed(), false);
    assert.ok((await getRuntime()).services["account-b"].webContentsId, "still awake after the veto");

    // Yes: the pop-out closes first, then the app sleeps.
    await sleepy.webContents.executeJavaScript("window.onbeforeunload = null; true");
    dialogAnswers.push({ response: 0 });
    assert.equal(await execute("window.commsApp.sleepService('account-b')"), true);
    await poll(() => sleepy.isDestroyed(), "the pop-out closed");
    await poll(async () => (await getRuntime()).services["account-b"].status === "sleeping", "account-b asleep");
    await execute("window.commsApp.setActiveService('account-b')");
    await poll(async () => (await getRuntime()).services["account-b"].status === "active", "account-b woken");
    await execute("window.commsApp.setActiveService('account-a')");
    await poll(() => attachedToMain(), "account-a selected again");
  });
  await run("site ownership follows the app: where its home address lands counts, a site it moves to does not", async () => {
    const cameraState = (page) => page.executeJavaScript("navigator.permissions.query({ name: 'camera' }).then((status) => status.state)");
    const showing = (page, url) => page.getURL().startsWith(url) && page.executeJavaScript("document.readyState === 'complete'");
    const created = (await execute(`window.commsApp.saveService(${JSON.stringify({ name: "Roamer", url: `${origin}/roamer` })})`))
      .services.find((service) => service.name === "Roamer");
    await execute(`window.commsApp.setActiveService(${JSON.stringify(created.id)})`);
    const roamer = webContents.fromId(await poll(() => getId(created.id), "the new app is loaded"));
    await poll(() => showing(roamer, `${origin}/roamer`), "its home page");
    assert.equal(await cameraState(roamer), "granted", "its own site");
    // The page moves itself to another site: the view now shows it, but it is not the app's site.
    await roamer.executeJavaScript(`location.href = ${JSON.stringify(`${crossOrigin}/moved-on`)}; true`, true);
    await poll(() => showing(roamer, `${crossOrigin}/moved-on`), "the page moved to another site");
    assert.notEqual(await cameraState(roamer), "granted", "the page shown now does not become the app's own site");
    // A home address that the server redirects to another site: where it lands is the app's own.
    await execute(`window.commsApp.saveService(${JSON.stringify({ ...created, url: `${origin}/redirect-home` })})`);
    await poll(() => showing(roamer, `${crossOrigin}/landed`), "the home address landed on the other site");
    assert.equal(await cameraState(roamer), "granted", "the landing page's site");
    dialogAnswers.push({ response: 0, checkboxChecked: false });
    await execute(`window.commsApp.removeService(${JSON.stringify(created.id)})`);
    await execute("window.commsApp.setActiveService('account-a')");
    await poll(() => attachedToMain(), "account-a selected again");
  });
  await run("downloads go straight to the Downloads folder under unique names and say so", async () => {
    await execute("window.__status = []; window.__offStatus = window.commsApp.onStatusMessage((message) => window.__status.push(message)); true");
    const toastCount = toasts.length;
    const first = path.join(downloadsDir, "report.txt");
    const second = path.join(downloadsDir, "report (1).txt");
    firstPage.downloadURL(`${origin}/download/one`);
    await poll(() => syncFs.existsSync(first) && toasts.length > toastCount, "first download saved");
    firstPage.downloadURL(`${origin}/download/two`);
    await poll(() => syncFs.existsSync(second) && toasts.length > toastCount + 1, "second download gets its own name");
    assert.equal(syncFs.readFileSync(first, "utf8"), "fixture report");
    const toast = toasts.at(-1);
    assert.equal(toast.title, "Download complete");
    assert.match(toast.body, /report \(1\)\.txt/);
    toast.emit("click");
    await poll(() => shownInFolder.includes(second), "the toast shows the file in its folder");
    const status = await poll(() => execute("window.__status.find((message) => message.text === 'Downloaded report.txt.') ?? null"), "status message");
    assert.equal(status.tone, "info");
    await execute("window.__offStatus(); true");
  });
  await run("removing an app asks first and can delete its sign-in data and icon", async () => {
    const { getAppIcon } = await import("../../electron/appIcon.js");
    const iconsDir = path.join(userData, "icons");
    await fs.mkdir(iconsDir, { recursive: true });
    const iconPath = path.join(iconsDir, "doomed-icon.png");
    await fs.writeFile(iconPath, getAppIcon().resize({ width: 16, height: 16 }).toPNG());
    const iconSource = pathToFileURL(iconPath).href;
    const firstIconPath = path.join(iconsDir, "doomed-first-icon.png");
    await fs.writeFile(firstIconPath, getAppIcon().resize({ width: 16, height: 16 }).toPNG());
    const created = (await execute(`window.commsApp.saveService(${JSON.stringify({
      name: "Doomed", url: `${origin}/doomed`, iconSource: pathToFileURL(firstIconPath).href
    })})`)).services.find((service) => service.name === "Doomed");
    // Replacing an uploaded icon deletes the old file once no app shows it.
    const saved = await execute(`window.commsApp.saveService(${JSON.stringify({ ...created, iconSource })})`);
    await poll(() => !syncFs.existsSync(firstIconPath), "the replaced icon is deleted");
    assert.ok(syncFs.existsSync(iconPath), "the new icon is kept");
    const doomed = saved.services.find((service) => service.name === "Doomed");
    assert.equal(doomed.iconSource, iconSource);
    await poll(async () => (await getRuntime()).services[doomed.id]?.status === "active", "the new app is loaded");
    const doomedSession = session.fromPartition(doomed.sessionPartition);
    await doomedSession.cookies.set({ url: origin, name: "signin", value: "1", expirationDate: Math.floor(Date.now() / 1000) + 3600 });

    let prompts = dialogCalls.length;
    assert.equal(await execute(`window.commsApp.removeService(${JSON.stringify(doomed.id)})`), null, "Cancel keeps the app");
    assert.equal(dialogCalls.length, prompts + 1);
    const confirm = dialogCalls.at(-1);
    assert.equal(confirm.message, "Remove Doomed?");
    assert.equal(confirm.checkboxLabel, "Also delete its sign-in data and cache");
    assert.equal(confirm.checkboxChecked, false, "deleting data is opt-in");
    assert.deepEqual([confirm.defaultId, confirm.cancelId], [1, 1], "Cancel is the default");
    assert.ok((await getState()).services.some((service) => service.id === doomed.id));

    // In the Add/Edit dialog a failure shows inside the dialog (its backdrop covers the titlebar).
    await execute(`window.commsApp.showServiceContextMenu(${JSON.stringify(doomed.id)})`);
    menuItem(menuPopups.at(-1).menu, "Edit…").click();
    await poll(() => execute("document.querySelector('.modal input')?.value === 'Doomed'"), "the dialog opens for Doomed");
    dialogAnswers.push(new Error("No dialog available"));
    await execute("document.querySelector('.modal .danger-button').click(); true");
    assert.match(await poll(() => execute("document.querySelector('.modal .modal-error')?.textContent ?? null"), "the failure is shown in the dialog"),
      /^Couldn't remove Doomed: No dialog available/);
    prompts = dialogCalls.length;
    await execute("document.querySelector('.modal .danger-button').click(); true");
    await poll(() => execute("!document.querySelector('.modal .modal-error') && !document.querySelector('.modal .danger-button').disabled"),
      "a cancelled confirm clears the error and shows none");
    assert.equal(dialogCalls.length, prompts + 1);
    assert.ok((await getState()).services.some((service) => service.id === doomed.id));
    await execute("document.querySelector('.modal .ghost-button').click(); true");
    await poll(() => execute("!document.querySelector('.modal-backdrop')"), "the dialog closes");

    dialogAnswers.push({ response: 0, checkboxChecked: true });
    const after = await execute(`window.commsApp.removeService(${JSON.stringify(doomed.id)})`);
    assert.equal(after.services.some((service) => service.id === doomed.id), false);
    assert.deepEqual(await doomedSession.cookies.get({}), [], "its sign-in data is deleted");
    await poll(() => !syncFs.existsSync(iconPath), "its uploaded icon is deleted");
    assert.match(await firstPage.executeJavaScript("document.cookie"), /account=A/, "other apps keep their sign-in");

    prompts = dialogCalls.length;
    const builtIn = await execute("window.commsApp.removeService('gmail')");
    assert.ok(builtIn.services.some((service) => service.id === "gmail"), "built-in apps cannot be removed");
    assert.equal(dialogCalls.length, prompts, "and nothing is asked");
    await execute("window.commsApp.setActiveService('account-a')");
    await poll(() => attachedToMain(), "account-a selected again");
    assert.equal(await getId("account-a"), firstId);
  });
  if (!simulateLinux && process.platform !== "linux") {
    await run("dock windows ignore close and a second launch expands a collapsed dock", async () => {
      await execute("window.commsApp.setWindowMode('dock')");
      const bubble = await poll(() => liveWindow("mode=bubble"), "bubble");
      await poll(() => bubble.isVisible(), "bubble shown");
      const quit = app.quit;
      let quits = 0;
      app.quit = () => { quits += 1; };
      try {
        bubble.close();
        liveWindow("mode=dock").close();
        await delay(100);
      } finally {
        app.quit = quit;
      }
      assert.equal(quits, 0, "closing a dock surface never quits");
      assert.equal(bubble.isDestroyed(), false);

      await execute("window.commsApp.setDockExpanded(false)");
      await poll(() => !bubble.isVisible() && liveWindow("trigger.html")?.isVisible(), "collapsed to the trigger");
      app.emit("second-instance", {}, [process.execPath], root);
      await poll(async () => (await getState()).ui.dockExpanded === true, "dock expanded by the second launch");
      await poll(() => bubble.isVisible() && liveWindow("mode=dock").isVisible(), "dock and bubble shown");
      assert.equal((await getState()).ui.windowMode, "dock", "a second launch keeps dock mode");
      await execute("window.commsApp.setWindowMode('full')");
    });
    await run("the dock rail's Edit… opens the editor in the bubble", async () => {
      await execute("window.commsApp.setWindowMode('dock')");
      const bubble = await poll(() => liveWindow("mode=bubble"), "bubble");
      const dock = await poll(() => liveWindow("mode=dock"), "dock rail");
      await poll(() => bubble.contentView.children.some((child) => child.webContents?.id === firstId), "dock ready");
      menuPopups.length = 0;
      assert.equal(await dock.webContents.executeJavaScript("window.commsApp.showServiceContextMenu('account-b')"), true);
      const rail = menuPopups.at(-1);
      assert.equal(rail.options.window, dock, "the menu pops on the dock rail");
      menuItem(rail.menu, "Edit…").click();
      await poll(() => bubble.webContents.executeJavaScript("document.querySelector('.modal input')?.value === 'account-b'"),
        "the bubble opens account-b's settings");
      assert.equal(sentCount(dock, "ui:edit-service"), 0, "the dock rail has no editor");
      await poll(() => !bubble.contentView.children.some((child) => child.webContents?.id === firstId), "the page is hidden behind the dialog");
      await bubble.webContents.executeJavaScript("document.querySelector('.modal .ghost-button').click(); true");
      await poll(() => bubble.webContents.executeJavaScript("!document.querySelector('.modal-backdrop')"), "the dialog closes");
      await poll(() => bubble.contentView.children.some((child) => child.webContents?.id === firstId), "the page is shown again");
      await execute("window.commsApp.setWindowMode('full')");
    });
  }
  await run("close quits by default; close-to-tray hides the main window until the app is revealed", async () => {
    assert.equal(main.isVisible(), true);
    const quit = app.quit;
    let quits = 0;
    app.quit = () => { quits += 1; };
    try {
      main.close();
      await delay(100);
      assert.equal(quits, 1, "the close button still quits unless close-to-tray is on (D2)");
      assert.equal(main.isDestroyed(), false);
    } finally {
      app.quit = quit;
    }

    assert.equal((await execute("window.commsApp.setAppSettings({ closeToTray: true })")).ui.closeToTray, true);
    main.close();
    await poll(() => !main.isVisible(), "main window hidden to the tray");
    assert.equal(main.isDestroyed(), false);
    await poll(() => !main.contentView.children.some((child) => child.webContents?.id === firstId), "page detached while hidden");
    assert.equal(webContents.fromId(firstId)?.isDestroyed(), false, "the selected app keeps running in the tray");
    app.emit("second-instance", {}, [process.execPath], root);
    await poll(() => main.isVisible(), "a second launch reveals the main window");
    await poll(() => main.contentView.children.some((child) => child.webContents?.id === firstId), "page shown again");
    assert.equal(await getId("account-a"), firstId);
    await execute("window.commsApp.setAppSettings({ closeToTray: false })");
  });
  await run("main window placement is kept on screen, saved and has the smaller minimum size", async () => {
    assert.deepEqual(main.getMinimumSize(), [800, 560]);
    const initial = main.getBounds();
    assert.ok(
      // 2 px of slack for DIP rounding on scaled displays.
      screen.getAllDisplays().some(({ workArea }) =>
        initial.x >= workArea.x - 2 && initial.y >= workArea.y - 2 &&
        initial.x + initial.width <= workArea.x + workArea.width + 2 &&
        initial.y + initial.height <= workArea.y + workArea.height + 2),
      `the main window starts inside a work area: ${JSON.stringify(initial)}`
    );
    const { workArea } = screen.getPrimaryDisplay();
    const target = { x: workArea.x + 20, y: workArea.y + 30, width: 900, height: 640 };
    main.setBounds(target);
    const expected = { ...main.getNormalBounds(), isMaximized: false };
    await pollSavedConfig((saved) => JSON.stringify(saved.mainWindowState) === JSON.stringify(expected), "window placement persisted");
    assert.equal("mainWindowState" in await getState(), false, "placement is not sent to renderers");
    // The current renderer's layout needs the larger size; later checks look at the page.
    main.setBounds(initial);
    await poll(() => main.contentView.children.some((child) => child.webContents?.id === firstId), "page shown at the original size");
  });
  await run("the tray menu follows fresh state and its tooltip shows unread", async () => {
    const { getAppIcon, getTrayIcon } = await import("../../electron/appIcon.js");
    assert.equal(getAppIcon().isEmpty(), false);
    assert.equal(getAppIcon().getSize().width, 256, "the tray uses build/icon.png, not the fallback");
    assert.equal(getTrayIcon().isEmpty(), false);
    assert.ok(getTrayIcon().getScaleFactors().length >= 2, "the tray icon has per-scale sizes");

    assert.ok(trayItem("Open full app") && trayItem("Quit Comms Hub"), "tray menu is set");
    if (simulateLinux || process.platform === "linux") {
      assert.equal(trayItem("Dock mode unavailable on Linux")?.enabled, false);
    } else {
      for (let round = 0; round < 2; round += 1) {
        trayItem("Enter dock mode").click();
        await poll(async () => (await getState()).ui.windowMode === "dock", `tray entered dock mode (round ${round + 1})`);
        await poll(() => trayItem("Show dock"), "menu rebuilt for dock mode");
        assert.equal(trayItem("Enter dock mode"), undefined);
        await poll(() => liveWindow("mode=bubble")?.contentView.children.some((child) => child.webContents?.id === firstId), "dock ready");
        trayItem("Open full app").click();
        await poll(async () => (await getState()).ui.windowMode === "full", `tray opened the full app (round ${round + 1})`);
        await poll(() => trayItem("Enter dock mode"), "menu rebuilt for full mode");
      }
      await poll(() => main.contentView.children.some((child) => child.webContents?.id === firstId), "page back on main");
    }

    const menusBefore = trayState.menus;
    await execute("window.commsApp.setSidebarCollapsed(true)");
    await execute("window.commsApp.setSidebarCollapsed(false)");
    await delay(100);
    assert.equal(trayState.menus, menusBefore, "unrelated state changes do not rebuild the menu");

    assert.equal(trayState.toolTip, "Comms Hub");
    await execute("window.commsApp.notifyServiceEvent({ serviceId: 'account-b', title: 'Ping', body: 'Hello' })");
    await poll(() => trayState.toolTip === "Comms Hub - 1 unread", "tooltip shows the unread total");
    await execute("window.commsApp.markNotificationsSeen('account-b')");
    await poll(() => trayState.toolTip === "Comms Hub", "tooltip cleared once seen");
  });
  assert.deepEqual(shellErrors, [], "No renderer/preload errors");
  report = { ok: true, platform: process.platform, simulatedLinux: simulateLinux, tests: results,
    guestCount: Object.values((await getRuntime()).services).filter((service) => service.webContentsId).length,
    processCount: app.getAppMetrics().length, processCounts, configIo };
} catch (error) {
  report = { ok: false, tests: results, error: error.stack || String(error), shellErrors };
}
console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify(report)}`);
server.close();
// Use production shutdown so its guest disposal path is exercised too.
app.quit();
setTimeout(() => app.exit(report.ok ? 0 : 1), 5000).unref();

}).catch((error) => { console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify({ok:false,error:error.stack || String(error)})}`); app.exit(1); });
