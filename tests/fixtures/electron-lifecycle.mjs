import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  WebContentsView
} from "electron";
import { createServiceManager } from "../../electron/serviceManager.js";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(fixtureDirectory, "..", "..");
const userData = path.resolve(process.env.COMMS_ELECTRON_USER_DATA || "");
const outputDirectory = path.resolve(process.env.COMMS_ELECTRON_TEST_OUTPUT || "");

if (!process.env.COMMS_ELECTRON_USER_DATA || !process.env.COMMS_ELECTRON_TEST_OUTPUT) {
  throw new Error("The Electron lifecycle fixture must be started by scripts/run-electron-tests.mjs.");
}

app.on("window-all-closed", () => {});
app.setPath("userData", userData);
app.setPath("sessionData", path.join(userData, "session-data"));
app.setPath("crashDumps", path.join(userData, "crash-dumps"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");

const results = [];
const artifacts = [];
const allContents = new Set();
const managers = new Set();
const notifications = [];
const mediaRequests = [];
const configuredSessions = new WeakSet();
const showTestWindows = process.platform === "linux" && Boolean(process.env.CI);
let server;
let origin;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll(check, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message})` : ""}`);
}

async function run(name, test) {
  const startedAt = Date.now();
  console.error(`[electron-test] START ${name}`);
  await test();
  results.push({ name, ok: true, durationMs: Date.now() - startedAt });
  console.error(`[electron-test] PASS ${name}`);
}

function page(name, { wide = false } = {}) {
  const width = wide ? "2400px" : "100%";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${name}</title>
    <style>
      html, body { margin: 0; width: 100%; min-height: 100%; overflow: hidden; }
      #surface { box-sizing: border-box; width: ${width}; height: 180px; padding: 12px; background: #17324d; color: white; }
      textarea { display: block; width: 260px; height: 60px; }
    </style>
  </head>
  <body>
    <main id="surface" data-service="${name}">
      <button id="activation" type="button">Activate</button>
      <textarea id="draft" aria-label="Draft"></textarea>
    </main>
    <script>
      window.fixture = {
        enableVeto() {
          window.addEventListener("beforeunload", (event) => {
            event.preventDefault();
            event.returnValue = "Unsaved fixture";
          });
        },
        requestMedia() {
          return navigator.mediaDevices.getUserMedia({ audio: true }).then(
            (stream) => { stream.getTracks().forEach((track) => track.stop()); return "granted"; },
            (error) => error.name
          );
        },
        notify() {
          new Notification("Fixture notification", { body: "Native bridge body", tag: "fixture-tag" });
        }
      };
    </script>
  </body>
</html>`;
}

function startServer() {
  server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const name = requestUrl.searchParams.get("name") || "shell";
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(page(name, { wide: requestUrl.searchParams.get("wide") === "1" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

const service = (id, options = {}) => ({
  id,
  name: id,
  url: `${origin}/service?name=${encodeURIComponent(id)}&wide=1`,
  isEnabled: true,
  useDefaultSession: false,
  sessionPartition: `persist:electron-test-${id}`,
  keepAliveInBackground: false,
  zoomFactor: 1,
  ...options
});

function configurePartition(partitionSession) {
  if (configuredSessions.has(partitionSession)) return;
  configuredSessions.add(partitionSession);
  partitionSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    let protectedService = false;
    if (permission === "media") {
      for (const manager of managers) {
        if (manager.protectMedia(contents.id)) {
          protectedService = true;
          break;
        }
      }
    }
    mediaRequests.push({ contentsId: contents.id, permission, mediaTypes: details?.mediaTypes || [], protectedService });
    callback(permission === "media");
  });
}

function createHarness(initialServices, activeServiceId, { idleTimeoutMs = 500 } = {}) {
  let state = {
    services: initialServices,
    ui: { activeServiceId, memorySaverEnabled: true }
  };
  const created = [];
  const runtimeEvents = [];
  const errors = [];
  const manager = createServiceManager({
    idleTimeoutMs,
    onRuntimeChanged: (runtime) => runtimeEvents.push(runtime),
    onError: (id, error) => errors.push({ id, message: error instanceof Error ? error.message : String(error) }),
    createView(config) {
      const partition = config.useDefaultSession ? undefined : config.sessionPartition;
      const partitionSession = partition ? session.fromPartition(partition) : session.defaultSession;
      configurePartition(partitionSession);
      const webPreferences = {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        nodeIntegrationInSubFrames: true,
        preload: path.join(root, "electron", "guestPreload.js"),
        backgroundThrottling: false
      };
      if (partition) webPreferences.partition = partition;
      const view = new WebContentsView({ webPreferences });
      const contents = view.webContents;
      const originalSetZoomFactor = contents.setZoomFactor.bind(contents);
      const zoomCalls = [];
      contents.setZoomFactor = (factor) => {
        zoomCalls.push(factor);
        return originalSetZoomFactor(factor);
      };
      const record = { config, view, contents, zoomCalls };
      created.push(record);
      allContents.add(contents);
      return view;
    }
  });
  managers.add(manager);
  manager.sync(state);
  return {
    manager,
    created,
    runtimeEvents,
    errors,
    get state() { return state; },
    update(next) {
      state = typeof next === "function" ? next(state) : next;
      manager.sync(state);
    },
    select(id) {
      state = { ...state, ui: { ...state.ui, activeServiceId: id } };
      manager.sync(state);
    },
    runtime(id) { return manager.getRuntimeState().services[id]; },
    dispose() {
      manager.dispose();
      managers.delete(manager);
    }
  };
}

async function waitForReady(contents) {
  await poll(async () => {
    if (contents.isDestroyed() || contents.isLoading()) return false;
    return contents.executeJavaScript("document.readyState === 'complete' && Boolean(window.fixture)");
  }, "service page did not finish loading");
  await poll(
    () => contents.executeJavaScript("Boolean(window.__commsNotificationBridgeInstalled)"),
    "guest preload notification bridge did not install"
  );
}

async function waitForDestroyed(contents) {
  await poll(() => contents.isDestroyed(), `webContents ${contents.id} was not destroyed`);
}

function trackWindow(window) {
  allContents.add(window.webContents);
  return window;
}

async function destroyWindow(window) {
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  window.destroy();
  await waitForDestroyed(contents);
}

ipcMain.on("guest:edited", (event) => {
  for (const manager of managers) {
    if (manager.markEdited(event.sender.id)) break;
  }
});

ipcMain.on("guest:notification", (event, payload) => {
  for (const manager of managers) {
    const serviceId = manager.getServiceIdForContents(event.sender.id);
    if (serviceId) {
      notifications.push({ serviceId, contentsId: event.sender.id, payload });
      break;
    }
  }
});

ipcMain.handle("app-state:get", () => ({ fixture: true }));

let fullWindow;
let bubbleWindow;
let shellWindow;
let failure;

app.whenReady().then(async () => {
await mkdir(outputDirectory, { recursive: true });
await startServer();

try {
  fullWindow = trackWindow(new BrowserWindow({
    show: showTestWindows,
    width: 1100,
    height: 850,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  }));
  bubbleWindow = trackWindow(new BrowserWindow({
    show: showTestWindows,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  }));

  await run("sandboxed shell preload exposes the commsApp API", async () => {
    shellWindow = trackWindow(new BrowserWindow({
      show: showTestWindows,
      width: 640,
      height: 480,
      webPreferences: {
        preload: path.join(root, "electron", "preload.js"),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    }));
    await shellWindow.loadURL(`${origin}/shell?name=shell`);
    const smoke = await shellWindow.webContents.executeJavaScript(`(async () => ({
      type: typeof window.commsApp,
      state: await window.commsApp.getState(),
      hasRuntime: typeof window.commsApp.getServiceRuntime,
      hasViewport: typeof window.commsApp.setServiceViewport,
      pageHasNode: typeof window.require
    }))()`);
    assert.deepEqual(smoke, {
      type: "object",
      state: { fixture: true },
      hasRuntime: "function",
      hasViewport: "function",
      pageHasNode: "undefined"
    });
    const preferences = shellWindow.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);

    await destroyWindow(shellWindow);
    shellWindow = null;
  });

  await run("isolated services keep identity and DOM state across native reparenting", async () => {
    const alpha = service("isolation-alpha", { sessionPartition: "persist:electron-isolation-alpha" });
    const beta = service("isolation-beta", {
      sessionPartition: "persist:electron-isolation-beta",
      keepAliveInBackground: true
    });
    const harness = createHarness([alpha, beta], alpha.id);
    const fullBounds = { x: 18, y: 24, width: 750, height: 600 };
    const bubbleBounds = { x: 11, y: 13, width: 700, height: 540 };
    harness.manager.setPresentation({ host: fullWindow, bounds: fullBounds, obscured: false, borderRadius: 10 });
    await poll(() => harness.created.length === 2, "both native service views were not created");
    const alphaRecord = harness.created.find((record) => record.config.id === alpha.id);
    const betaRecord = harness.created.find((record) => record.config.id === beta.id);
    await Promise.all([waitForReady(alphaRecord.contents), waitForReady(betaRecord.contents)]);

    assert.notEqual(alphaRecord.contents.id, betaRecord.contents.id);
    assert.equal(harness.manager.getServiceIdForContents(alphaRecord.contents.id), alpha.id);
    assert.equal(harness.manager.getServiceIdForContents(betaRecord.contents.id), beta.id);
    const preferences = alphaRecord.contents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegrationInSubFrames, true);

    await alphaRecord.contents.executeJavaScript("document.cookie = 'partition_cookie=alpha; path=/'");
    await betaRecord.contents.executeJavaScript("document.cookie = 'partition_cookie=beta; path=/'");
    assert.match(await alphaRecord.contents.executeJavaScript("document.cookie"), /partition_cookie=alpha/);
    assert.match(await betaRecord.contents.executeJavaScript("document.cookie"), /partition_cookie=beta/);

    await alphaRecord.contents.executeJavaScript("document.querySelector('#draft').focus(); document.querySelector('#draft').value = ''");
    alphaRecord.contents.debugger.attach("1.3");
    await alphaRecord.contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await alphaRecord.contents.debugger.sendCommand("Input.insertText", { text: "draft42" });
    alphaRecord.contents.debugger.detach();
    await poll(
      () => alphaRecord.contents.executeJavaScript("document.querySelector('#draft').value === 'draft42'"),
      "trusted draft input was not delivered"
    );
    await poll(
      () => harness.runtime(alpha.id)?.protectionReason === "active",
      "active service did not remain active after editing"
    );
    await alphaRecord.contents.executeJavaScript("location.hash = 'native-navigation'");
    await poll(() => alphaRecord.contents.getURL().endsWith("#native-navigation"), "in-page navigation was not retained");

    const originalId = alphaRecord.contents.id;
    harness.manager.setPresentation({ host: bubbleWindow, bounds: bubbleBounds, obscured: false });
    assert.deepEqual(alphaRecord.view.getBounds(), bubbleBounds);
    assert.equal(alphaRecord.contents.id, originalId);
    assert.equal(await alphaRecord.contents.executeJavaScript("document.querySelector('#draft').value"), "draft42");
    assert.ok(alphaRecord.contents.getURL().endsWith("#native-navigation"));

    harness.manager.setPresentation({ obscured: true });
    assert.equal(alphaRecord.contents.id, originalId);
    assert.deepEqual(alphaRecord.view.getBounds(), bubbleBounds);
    assert.equal(await alphaRecord.contents.executeJavaScript("document.querySelector('#draft').value"), "draft42");
    harness.manager.setPresentation({ obscured: false });
    assert.equal(alphaRecord.contents.id, originalId);
    assert.deepEqual(alphaRecord.view.getBounds(), bubbleBounds);

    await alphaRecord.contents.executeJavaScript("window.fixture.notify()");
    await poll(
      () => notifications.some((entry) => entry.serviceId === alpha.id && entry.payload.title === "Fixture notification"),
      "guest notification IPC was not attributed to its service"
    );
    const notification = notifications.find((entry) => entry.serviceId === alpha.id);
    assert.deepEqual(notification.payload, {
      title: "Fixture notification",
      body: "Native bridge body",
      tag: "fixture-tag"
    });

    harness.select(beta.id);
    await poll(() => harness.runtime(alpha.id)?.protectionReason === "edited", "trusted guest edit was not protected");

    harness.dispose();
    await Promise.all(harness.created.map((record) => waitForDestroyed(record.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("active-only zoom uses exact logical view bounds and CSS viewports", async () => {
    const sharedPartition = "persist:electron-shared-zoom";
    const primary = service("zoom-primary", { sessionPartition: sharedPartition, zoomFactor: 1 });
    const secondary = service("zoom-secondary", {
      sessionPartition: sharedPartition,
      zoomFactor: 0.8,
      keepAliveInBackground: true
    });
    const harness = createHarness([primary, secondary], primary.id);
    const bounds = { x: 0, y: 0, width: 750, height: 600 };
    harness.manager.setPresentation({ host: fullWindow, bounds, obscured: false, borderRadius: 0 });
    await poll(() => harness.created.length === 2, "shared-session views were not created");
    const primaryRecord = harness.created.find((record) => record.config.id === primary.id);
    const secondaryRecord = harness.created.find((record) => record.config.id === secondary.id);
    await Promise.all([waitForReady(primaryRecord.contents), waitForReady(secondaryRecord.contents)]);
    assert.equal(secondaryRecord.zoomCalls.length, 0, "inactive shared-session service wrote zoom");

    const viewport = (record) => record.contents.executeJavaScript(`({
      innerWidth,
      innerHeight,
      scrollWidth: document.getElementById("surface").scrollWidth
    })`);
    for (const [factor, expected] of [[1, [750, 600]], [1.25, [600, 480]], [1.5, [500, 400]]]) {
      harness.update((state) => ({
        ...state,
        services: state.services.map((item) => item.id === primary.id ? { ...item, zoomFactor: factor } : item)
      }));
      await poll(() => Math.abs(primaryRecord.contents.getZoomFactor() - factor) < 0.001, `zoom ${factor} was not applied`);
      const measured = await viewport(primaryRecord);
      assert.deepEqual([measured.innerWidth, measured.innerHeight], expected);
      assert.ok(measured.scrollWidth > measured.innerWidth, "wide fixture should exceed the responsive viewport");
      assert.deepEqual(primaryRecord.view.getBounds(), bounds, "zoom must not alter native view bounds");

    }

    const primaryCallCount = primaryRecord.zoomCalls.length;
    harness.select(secondary.id);
    await poll(() => Math.abs(secondaryRecord.contents.getZoomFactor() - 0.8) < 0.001, "secondary zoom was not applied when active");
    assert.equal(secondaryRecord.zoomCalls.at(-1), 0.8);
    primaryRecord.contents.reload();
    await waitForReady(primaryRecord.contents);
    assert.equal(primaryRecord.zoomCalls.length, primaryCallCount, "inactive reload wrote shared-session zoom");
    assert.deepEqual(primaryRecord.view.getBounds(), bounds);
    harness.dispose();
    await Promise.all(harness.created.map((record) => waitForDestroyed(record.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("native media permission protects an inactive service", async () => {
    const protectedService = service("media-protected", { sessionPartition: "persist:electron-media" });
    const anchor = service("media-anchor", { sessionPartition: "persist:electron-media-anchor" });
    const harness = createHarness([protectedService, anchor], protectedService.id, { idleTimeoutMs: 180 });
    harness.manager.setPresentation({ host: fullWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const mediaRecord = harness.created[0];
    await waitForReady(mediaRecord.contents);
    await mediaRecord.contents.executeJavaScript("window.fixture.requestMedia()");
    await poll(
      () => mediaRequests.some((request) => request.contentsId === mediaRecord.contents.id && request.permission === "media" && request.protectedService),
      "native media permission request did not protect the service"
    );
    harness.select(anchor.id);
    await delay(300);
    assert.equal(mediaRecord.contents.isDestroyed(), false);
    assert.equal(harness.runtime(protectedService.id).protectionReason, "media");
    harness.dispose();
    await Promise.all(harness.created.map((record) => waitForDestroyed(record.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("actual beforeunload veto keeps the native contents alive", async () => {
    const veto = service("beforeunload-veto", { sessionPartition: "persist:electron-veto" });
    const anchor = service("beforeunload-anchor", { sessionPartition: "persist:electron-veto-anchor" });
    const harness = createHarness([veto, anchor], veto.id, { idleTimeoutMs: 180 });
    harness.manager.setPresentation({ host: fullWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const vetoRecord = harness.created[0];
    await waitForReady(vetoRecord.contents);
    await vetoRecord.contents.executeJavaScript("window.fixture.enableVeto()");
    vetoRecord.contents.debugger.attach("1.3");
    await vetoRecord.contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await vetoRecord.contents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 20, button: "left", clickCount: 1 });
    await vetoRecord.contents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 20, button: "left", clickCount: 1 });
    vetoRecord.contents.debugger.detach();
    harness.select(anchor.id);
    await poll(() => harness.runtime(veto.id)?.protectionReason === "beforeunload", "beforeunload did not veto the native close");
    assert.equal(vetoRecord.contents.isDestroyed(), false);
    assert.equal(harness.runtime(veto.id).webContentsId, vetoRecord.contents.id);
    await delay(300);
    assert.equal(vetoRecord.contents.isDestroyed(), false, "vetoed close was retried or forced");
    harness.dispose();
    await Promise.all(harness.created.map((record) => waitForDestroyed(record.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("clean autosleep destroys and recreates with cookies and last URL", async () => {
    const sleepy = service("sleep-clean", { sessionPartition: "persist:electron-clean-sleep" });
    const anchor = service("sleep-anchor", { sessionPartition: "persist:electron-clean-anchor" });
    const harness = createHarness([sleepy, anchor], sleepy.id, { idleTimeoutMs: 180 });
    harness.manager.setPresentation({ host: bubbleWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const original = harness.created[0];
    await waitForReady(original.contents);
    await original.contents.executeJavaScript("document.cookie = 'sleep_cookie=retained; path=/'; location.hash = 'sleep-route'");
    await poll(() => original.contents.getURL().endsWith("#sleep-route"), "sleep route was not committed");
    const originalId = original.contents.id;
    harness.select(anchor.id);
    await waitForDestroyed(original.contents);
    assert.equal(harness.runtime(sleepy.id).status, "sleeping");
    assert.ok(harness.runtime(sleepy.id).lastUrl.endsWith("#sleep-route"));
    assert.equal(harness.manager.getServiceIdForContents(originalId), null);

    harness.select(sleepy.id);
    await poll(() => harness.created.length === 3, "sleeping service did not recreate");
    const recreated = harness.created.at(-1);
    await waitForReady(recreated.contents);
    assert.notEqual(recreated.contents.id, originalId);
    assert.ok(recreated.contents.getURL().endsWith("#sleep-route"));
    assert.match(await recreated.contents.executeJavaScript("document.cookie"), /sleep_cookie=retained/);
    harness.dispose();
    await Promise.all(harness.created.map((record) => waitForDestroyed(record.contents)));
    assert.deepEqual(harness.errors, []);
  });
} catch (error) {
  failure = error;
} finally {
  for (const manager of managers) manager.dispose();
  managers.clear();
  await Promise.allSettled([
    destroyWindow(shellWindow),
    destroyWindow(bubbleWindow),
    destroyWindow(fullWindow)
  ]);
  if (server) await new Promise((resolve) => server.close(resolve));
}

let remainingContents = 0;
for (const contents of allContents) {
  if (!contents.isDestroyed()) remainingContents += 1;
}
if (!failure && remainingContents) {
  failure = new Error(`${remainingContents} Electron webContents remained alive after disposal`);
}

const report = {
  ok: !failure,
  electron: process.versions.electron,
  platform: process.platform,
  tests: results,
  assertions: {
    notificationsCaptured: notifications.length,
    mediaPermissionRequests: mediaRequests.length,
    remainingContents
  },
  transientArtifacts: artifacts,
  ...(failure ? {
    error: failure instanceof Error ? failure.message : String(failure),
    stack: failure instanceof Error ? failure.stack : undefined
  } : {})
};

console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify(report)}`);
setTimeout(() => app.exit(failure ? 1 : 0), 50);

}).catch((error) => { console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify({ok:false,error:error.stack || String(error)})}`); app.exit(1); });
