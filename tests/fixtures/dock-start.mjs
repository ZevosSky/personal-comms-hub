import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { app, BrowserWindow, dialog, Menu, Notification, shell, webContents } from "electron";

// Starts the production main process in dock mode (the dock collapsed to its trigger) with a
// synthetic local account and hidden native windows. Dock mode must never create the full window;
// switching to full mode creates it on demand. No account/profile data or remote service is used.
const userData = process.env.COMMS_ELECTRON_USER_DATA;
if (!userData) throw new Error("Start this fixture using scripts/run-electron-tests.mjs.");
// Dock mode is unavailable on Linux; app-shell and linux-policy cover that path.
const skipped = process.platform === "linux";
app.setPath("userData", userData);
app.setPath("sessionData", path.join(userData, "sessions"));
const downloadsDir = path.join(userData, "downloads");
app.setPath("downloads", downloadsDir);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: "v1.2.2", assets: [] }) });
// Shorten main's 60 s teardown of the hidden full window in dock mode so it can be observed.
const mainTeardownDelayMs = 60000;
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  originalSetTimeout(callback, delay === mainTeardownDelayMs ? 3000 : delay, ...args);

// Toasts, external opens, dialogs and menus are recorded instead of reaching the desktop.
const toasts = [];
Notification.prototype.show = function show() { toasts.push(this); };
shell.openExternal = async () => {};
dialog.showMessageBox = async (...args) => ({ response: args.at(-1).cancelId ?? 0, checkboxChecked: false });
const menuPopups = [];
Menu.prototype.popup = function popup(options) { menuPopups.push({ menu: this, options }); };
const menuItem = (menu, label) => menu.items.find((item) => item.label === label);

const windows = [];
const shellErrors = [];
const sentMessages = new WeakMap();
const sentCount = (window, channel) => sentMessages.get(window)?.get(channel) ?? 0;
// Taskbar progress main sets on each window (the last value; -1 clears it).
const progressBars = new Map();
const liveWindow = (marker) =>
  windows.findLast((window) => !window.isDestroyed() && window.webContents.getURL().includes(marker));
const fullWindows = () => windows.filter((window) => !window.isDestroyed() && window.webContents.getURL().includes("mode=full"));
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
  window.show = window.showInactive = () => { if (!visible) { visible = true; window.emit("show"); } };
  window.hide = () => { if (visible) { visible = false; window.emit("hide"); } };
  window.isVisible = () => visible;
  window.focus = window.moveTop = () => {};
  const setProgressBar = window.setProgressBar.bind(window);
  window.setProgressBar = (value, options) => { progressBars.set(window, value); return setProgressBar(value, options); };
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
const server = http.createServer((request, response) => {
  if (request.url.startsWith("/forbidden/")) {
    // Refused downloads end as "interrupted" (a network error would be retried instead).
    response.writeHead(403, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="refused.txt"' });
    response.end("no");
    return;
  }
  if (request.url.startsWith("/dropped/")) {
    // The connection drops mid-file: Chromium restarts a few times, then leaves the item
    // interrupted without 'done' (no validators, so it could only restart on request).
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "1000000",
      "Content-Disposition": 'attachment; filename="dropped.bin"' });
    response.write(Buffer.alloc(64 * 1024));
    setTimeout(() => response.socket?.destroy(), 100);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><title>Account ${request.url}</title><main><h1>Account ${request.url}</h1><textarea id="draft"></textarea></main>`);
});

app.whenReady().then(async () => {
if (skipped) {
  console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify({ ok: true, skipped: "dock mode is unavailable on Linux" })}`);
  app.exit(0);
  return;
}
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(path.join(userData, "comms-app-config.json"), JSON.stringify({
  services: [
    ...["gmail", "discord", "messenger", "slack", "teams"].map((id) => ({ id, isEnabled: false })),
    { id: "account-a", name: "account-a", url: `${origin}/account-a`, isEnabled: true, sessionPartition: "persist:account-a",
      keepAliveInBackground: true, notificationSettings: { desktopEnabled: true, captureWebNotifications: true, badgeEnabled: true } }
  ],
  ui: { activeServiceId: "account-a", memorySaverEnabled: false, notificationsEnabled: true, windowMode: "dock",
    dockExpanded: false, sidebarCollapsed: false }
}));

const results = [];
const run = async (name, check) => { await check(); results.push({ name, ok: true }); };
const processCounts = {};
let report;
try {
  await import("../../electron/main.js");
  const dock = await poll(() => liveWindow("mode=dock"), "dock rail");
  const viaDock = (script) => dock.webContents.executeJavaScript(script);
  await poll(() => viaDock("Boolean(window.commsApp) && document.readyState === 'complete'"), "dock rail ready");
  const getState = () => viaDock("window.commsApp.getState()");
  const getRuntime = () => viaDock("window.commsApp.getServiceRuntime()");
  const guestId = await poll(async () => (await getRuntime()).services["account-a"]?.webContentsId, "account page loaded");
  const guest = webContents.fromId(guestId);
  const attachedTo = (window) => Boolean(window) && window.contentView.children.some((child) => child.webContents?.id === guestId);

  await run("a collapsed dock start creates no full window", async () => {
    const trigger = await poll(() => liveWindow("trigger.html"), "trigger");
    await poll(() => trigger.isVisible(), "the collapsed dock shows its trigger");
    await delay(300);
    assert.deepEqual(fullWindows(), [], "dock mode never loads the full window");
    assert.equal(liveWindow("mode=bubble"), undefined, "the bubble waits until the dock is expanded");
    processCounts.collapsedDock = app.getAppMetrics().length;
  });

  await run("the rail's Edit… expands the dock and opens the editor in the new bubble", async () => {
    menuPopups.length = 0;
    assert.equal(await viaDock("window.commsApp.showServiceContextMenu('account-a')"), true);
    assert.equal(menuPopups.at(-1).options.window, dock);
    menuItem(menuPopups.at(-1).menu, "Edit…").click();
    const bubble = await poll(() => liveWindow("mode=bubble"), "bubble created");
    await poll(() => bubble.webContents.executeJavaScript("document.querySelector('.modal input')?.value === 'account-a'"),
      "the editor opens once the bubble's renderer listens");
    assert.equal((await getState()).ui.dockExpanded, true);
    assert.equal(bubble.isVisible(), true);
    await bubble.webContents.executeJavaScript("document.querySelector('.modal .ghost-button').click(); true");
    await poll(() => attachedTo(bubble), "the page is shown in the bubble");
    assert.deepEqual(fullWindows(), []);
    processCounts.expandedDock = app.getAppMetrics().length;
  });

  await run("status messages reach the visible bubble; a failed download also gets a toast", async () => {
    const bubble = liveWindow("mode=bubble");
    const statusSends = sentCount(bubble, "ui:status");
    const toastCount = toasts.length;
    guest.downloadURL(`${origin}/forbidden/one`);
    const toast = await poll(() => toasts.slice(toastCount).find((item) => item.title === "Download failed"), "download failure toast", 15000);
    assert.match(toast.body, /refused/);
    await poll(() => sentCount(bubble, "ui:status") > statusSends, "the failure is also shown in the bubble");
  });

  await run("a download whose connection drops reports one failure and clears the taskbar progress", async () => {
    const bubble = liveWindow("mode=bubble");
    const toastCount = toasts.length;
    guest.downloadURL(`${origin}/dropped/one`);
    await poll(() => typeof progressBars.get(bubble) === "number" && progressBars.get(bubble) !== -1, "progress shown on the bubble");
    const toast = await poll(() => toasts.slice(toastCount).find((item) => item.title === "Download failed"), "download failure toast", 30000);
    assert.match(toast.body, /dropped/);
    assert.equal(progressBars.get(bubble), -1, "the taskbar progress is cleared");
    await delay(500);
    assert.equal(toasts.slice(toastCount).filter((item) => item.title === "Download failed").length, 1, "reported once");
    const leftovers = (await fs.readdir(downloadsDir).catch(() => [])).filter((name) => /dropped|crdownload/i.test(name));
    assert.deepEqual(leftovers, [], "no partial file is left behind");
  });

  await run("with the dock collapsed, an error becomes a toast and a notification click reveals the dock", async () => {
    const bubble = liveWindow("mode=bubble");
    await viaDock("window.commsApp.setDockExpanded(false)");
    await poll(() => !bubble.isVisible(), "the bubble hides");
    await poll(() => guest.executeJavaScript("document.readyState === 'complete' && Boolean(window.__commsNotificationBridgeInstalled)"), "page ready");

    let toastCount = toasts.length;
    const statusSends = sentCount(bubble, "ui:status");
    await guest.executeJavaScript("window.open('search-ms:query=x'); true", true);
    const blocked = await poll(() => toasts.slice(toastCount).find((item) => item.title === "Comms Hub"), "a blocked link is reported by a toast");
    assert.match(blocked.body, /Blocked a link/);
    assert.equal(sentCount(bubble, "ui:status"), statusSends, "nothing is sent to the hidden bubble");

    toastCount = toasts.length;
    await guest.executeJavaScript(`window.__clicks = 0;
      new Notification("Lunch?", { body: "Soon" }).onclick = () => { window.__clicks += 1; }; true`, true);
    const toast = await poll(() => toasts.slice(toastCount).find((item) => item.title === "account-a: Lunch?"), "a toast for the page notification");
    toast.emit("click");
    await poll(async () => (await getState()).ui.dockExpanded === true, "the click expands the dock");
    await poll(() => bubble.isVisible() && attachedTo(bubble), "the page is shown in the bubble");
    await poll(() => guest.executeJavaScript("window.__clicks === 1"), "the click reaches the page");
    assert.deepEqual(fullWindows(), [], "a notification click keeps dock mode");
  });

  await run("switching to full mode creates the full window and moves the page into it", async () => {
    await viaDock("window.commsApp.setWindowMode('full')");
    const main = await poll(() => fullWindows()[0], "full window created");
    await poll(() => main.isVisible() && attachedTo(main), "the page moves to the full window");
    assert.equal((await getState()).ui.windowMode, "full");
    assert.equal((await getRuntime()).services["account-a"].webContentsId, guestId, "the page was not reloaded");
    assert.equal(attachedTo(liveWindow("mode=bubble")), false);
    processCounts.fullMode = app.getAppMetrics().length;
  });

  await run("back in dock mode the hidden full window is destroyed after a while; full mode recreates it", async () => {
    const main = fullWindows()[0];
    // A quick return to full mode cancels the teardown.
    await viaDock("window.commsApp.setWindowMode('dock')");
    await poll(() => attachedTo(liveWindow("mode=bubble")), "the page moves to the bubble");
    await viaDock("window.commsApp.setWindowMode('full')");
    await poll(() => main.isVisible() && attachedTo(main), "the page moves back to the full window");
    await delay(3600);
    assert.equal(main.isDestroyed(), false, "the teardown is cancelled by full mode");

    await viaDock("window.commsApp.setWindowMode('dock')");
    await poll(() => attachedTo(liveWindow("mode=bubble")), "the page moves to the bubble again");
    assert.equal(main.isVisible(), false);
    await poll(() => main.isDestroyed(), "the hidden full window is destroyed", 10000);
    assert.deepEqual(fullWindows(), []);
    assert.equal(attachedTo(liveWindow("mode=bubble")), true, "the page stays in the bubble");
    processCounts.dockAfterTeardown = app.getAppMetrics().length;

    await viaDock("window.commsApp.setWindowMode('full')");
    const next = await poll(() => fullWindows()[0], "a new full window");
    assert.notEqual(next, main);
    await poll(() => next.isVisible() && attachedTo(next), "the page moves into the new full window");
    assert.equal((await getRuntime()).services["account-a"].webContentsId, guestId, "the page was not reloaded");
  });

  await run("nothing failed along the way", async () => {
    const log = await fs.readFile(path.join(userData, "startup.log"), "utf8").catch(() => "");
    const problems = log.split(/\n\n/).filter((entry) => /Uncaught|Unhandled|Failed/i.test(entry));
    assert.deepEqual(problems, [], "no errors in startup.log");
    assert.deepEqual(shellErrors, [], "No renderer/preload errors");
  });
  report = { ok: true, platform: process.platform, tests: results, processCounts };
} catch (error) {
  report = { ok: false, tests: results, error: error.stack || String(error), shellErrors };
}
console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify(report)}`);
server.close();
app.quit();
setTimeout(() => app.exit(report.ok ? 0 : 1), 5000).unref();

}).catch((error) => { console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify({ ok: false, error: error.stack || String(error) })}`); app.exit(1); });
