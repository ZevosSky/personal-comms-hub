import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, screen, webContents } from "electron";

// Exercise production IPC and renderer using synthetic accounts and hidden native windows.
// No account/profile data or remote service is used by this fixture.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const userData = process.env.COMMS_ELECTRON_USER_DATA;
if (!userData) throw new Error("Start this fixture using scripts/run-electron-tests.mjs.");
app.setPath("userData", userData);
app.setPath("sessionData", path.join(userData, "sessions"));
const simulateLinux = process.argv.includes("--linux") || process.env.COMMS_TEST_LINUX === "1";
if (simulateLinux) Object.defineProperty(process, "platform", { value: "linux" });
globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: "v1.2.2", assets: [] }) });

const windows = [];
const shellErrors = [];
app.on("browser-window-created", (_event, window) => {
  windows.push(window);
  let visible = false;
  // Keep native windows hidden on the user's desktop while exercising lifecycle events.
  window.show = window.showInactive = () => { if (!visible) { visible = true; window.emit("show"); } };
  window.hide = () => { if (visible) { visible = false; window.emit("hide"); } };
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
const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><title>Account ${request.url}</title><style>body{margin:0;background:white;color:#111}main{width:100%;box-sizing:border-box;border:2px solid blue}textarea{width:70%}</style><main><h1>Account ${request.url}</h1><textarea id="draft"></textarea><button id="right" style="float:right">Right edge</button></main>`);
});
app.whenReady().then(async () => {
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(path.join(userData, "comms-app-config.json"), JSON.stringify({
  services: [
    ...["gmail", "discord", "messenger", "slack", "teams"].map((id) => ({ id, isEnabled: false })),
    ...["account-a", "account-b"].map((id) => ({ id, name: id, url: `${origin}/${id}`, isEnabled: true,
      sessionPartition: `persist:${id}`, keepAliveInBackground: true,
      notificationSettings: { desktopEnabled: false, captureWebNotifications: true, badgeEnabled: true } }))
  ],
  ui: { activeServiceId: "account-a", memorySaverEnabled: true, notificationsEnabled: false,
    windowMode: simulateLinux || process.platform === "linux" ? "dock" : "full", sidebarCollapsed: false, dockExpanded: true },
  notificationHistory: []
}));

const results = [];
const run = async (name, check) => { await check(); results.push({ name, ok: true }); };
let report;
try {
  await import("../../electron/main.js");
  const main = await poll(() => windows[0], "main window");
  const execute = (script) => main.webContents.executeJavaScript(script);
  await poll(() => execute("Boolean(window.commsApp && document.querySelector('.service-viewport'))"), "renderer ready");
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
      const bubble = await poll(() => windows.find((window) => window.webContents.getURL().includes("mode=bubble")), "bubble");
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
      const bubble = windows.find((window) => window.webContents.getURL().includes("mode=bubble"));
      await poll(() => bubble.contentView.children.some((child) => child.webContents?.id === firstId), "bubble viewport");
      const view = bubble.contentView.children.find((child) => child.webContents === firstPage);
      const bounds = view.getBounds();
      assert.ok(bounds.y >= 30 && bounds.width > 0);
      assert.ok(bounds.y + bounds.height <= bubble.getContentSize()[1]);
      assert.deepEqual((await getState()).ui.bubbleSize, { width: 860, height: 660 });
      if (process.env.COMMS_CAPTURE_TEST_IMAGES === "1") {
      const artifactDirectory = path.join(root, "out", "verification");
      await fs.mkdir(artifactDirectory, { recursive: true });
      const dock = windows.find((window) => window.webContents.getURL().includes("mode=dock"));
      await dock.webContents.executeJavaScript("document.documentElement.style.background='white';document.body.style.background='white'");
      await fs.writeFile(path.join(artifactDirectory, "dock-on-white.png"), (await dock.webContents.capturePage()).toPNG());
      await fs.writeFile(path.join(artifactDirectory, "bubble-toolbar.png"), (await bubble.webContents.capturePage()).toPNG());
      }
      bubble.setSize(700, 560);
      await delay(250);
      assert.deepEqual((await getState()).ui.bubbleSize, { width: 860, height: 660 }, "programmatic resize must preserve preference");
      await execute("window.commsApp.setWindowMode('full')");
    });
  }
  await run("zoom and reload controls reach the selected native page", async () => {
    await execute("window.commsApp.setServiceZoom('account-a', 0.8)");
    assert.equal(firstPage.getZoomFactor(), 0.8);
    assert.equal((await getState()).services.find((service) => service.id === "account-a").zoomFactor, 0.8);
    await execute("window.commsApp.refreshActiveWebview()");
    await poll(() => firstPage.executeJavaScript("document.querySelector('#draft')?.value === ''"), "reload");
    assert.equal(await getId("account-a"), firstId);
    assert.match(await firstPage.executeJavaScript("document.cookie"), /account=A/);
  });
  assert.deepEqual(shellErrors, [], "No renderer/preload errors");
  report = { ok: true, platform: process.platform, simulatedLinux: simulateLinux, tests: results,
    guestCount: Object.values((await getRuntime()).services).filter((service) => service.webContentsId).length,
    processCount: app.getAppMetrics().length };
} catch (error) {
  report = { ok: false, tests: results, error: error.stack || String(error), shellErrors };
}
console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify(report)}`);
server.close();
// Use production shutdown so its guest disposal path is exercised too.
app.quit();
setTimeout(() => app.exit(report.ok ? 0 : 1), 5000).unref();

}).catch((error) => { console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify({ok:false,error:error.stack || String(error)})}`); app.exit(1); });
