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
import { createFrameStateQuery, frameKeyOf, frameTargetsFor } from "../../electron/guestFrames.js";
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
const notificationCloses = [];
const editReports = [];
const captureReports = [];
const stateReplies = [];
const mediaRequests = [];
const configuredSessions = new WeakSet();
const frameStateQuery = createFrameStateQuery();
let server;
let otherServer;
let origin;
let otherOrigin;

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
      <input id="search" type="text" placeholder="Search messages">
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
        startMedia() {
          return navigator.mediaDevices.getUserMedia({ audio: true }).then(
            (stream) => { window.fixture.stream = stream; return stream.getTracks().length; },
            (error) => error.name
          );
        },
        stopMedia() {
          window.fixture.stream.getTracks().forEach((track) => track.stop());
        },
        notify() {
          new Notification("Fixture notification", { body: "Native bridge body", tag: "fixture-tag" });
        },
        tracked: [],
        notifyTracked(title, options) {
          const notification = new Notification(title, options);
          const record = { clicks: 0, listenerClicks: 0, shows: 0, closes: 0, errors: 0 };
          notification.onclick = (event) => {
            record.clicks += 1;
            record.clickTarget = event.target === notification && event.currentTarget === notification;
          };
          notification.addEventListener("click", () => { record.listenerClicks += 1; });
          notification.onshow = () => { record.shows += 1; };
          notification.onclose = () => { record.closes += 1; };
          notification.onerror = () => { record.errors += 1; };
          window.fixture.tracked.push({ notification, record });
          return window.fixture.tracked.length - 1;
        },
        record(index) { return window.fixture.tracked[index].record; },
        closeTracked(index) { window.fixture.tracked[index].notification.close(); },
        addFrame(src) {
          return new Promise((resolve) => {
            const frame = document.createElement("iframe");
            frame.src = src;
            frame.onload = () => resolve(true);
            document.body.append(frame);
          });
        }
      };
    </script>
  </body>
</html>`;
}

function listen() {
  const created = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const name = requestUrl.searchParams.get("name") || "shell";
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(page(name, { wide: requestUrl.searchParams.get("wide") === "1" }));
  });
  return new Promise((resolve, reject) => {
    created.once("error", reject);
    created.listen(0, "127.0.0.1", () => resolve({ server: created, origin: `http://127.0.0.1:${created.address().port}` }));
  });
}

// A second port is a second origin, for cross-origin frames.
async function startServer() {
  ({ server, origin } = await listen());
  ({ server: otherServer, origin: otherOrigin } = await listen());
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
    // Like main's policy (D10): notifications are allowed because Comms Hub routes them.
    callback(permission === "media" || permission === "notifications");
  });
}

function createHarness(initialServices, activeServiceId, { idleTimeoutMs = 500, captureGraceMs = 300 } = {}) {
  let state = {
    services: initialServices,
    ui: { activeServiceId, memorySaverEnabled: true }
  };
  const created = [];
  const runtimeEvents = [];
  const errors = [];
  const manager = createServiceManager({
    idleTimeoutMs,
    captureGraceMs,
    queryFrames: (contents, keys) => frameStateQuery.query(frameTargetsFor(contents, keys)),
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

// The same guest channels main.js listens to, routed to whichever harness owns the page.
const ownerOf = (contentsId) => [...managers].find((manager) => manager.getServiceIdForContents(contentsId));

ipcMain.on("guest:edited", (event, dirty) => {
  editReports.push({ contentsId: event.sender.id, dirty });
  ownerOf(event.sender.id)?.setEdited(event.sender.id, frameKeyOf(event.senderFrame), dirty === true);
});

ipcMain.on("guest:capture", (event, live) => {
  captureReports.push({ contentsId: event.sender.id, live });
  ownerOf(event.sender.id)?.setCapture(event.sender.id, frameKeyOf(event.senderFrame), live);
});

ipcMain.on("guest:state", (event, payload) => {
  stateReplies.push({ contentsId: event.sender.id, payload });
  frameStateQuery.receive(frameKeyOf(event.senderFrame), payload);
});

ipcMain.on("guest:notification", (event, payload) => {
  const serviceId = ownerOf(event.sender.id)?.getServiceIdForContents(event.sender.id);
  if (serviceId) notifications.push({ serviceId, contentsId: event.sender.id, frame: event.senderFrame, frameUrl: event.senderFrame?.url, payload });
});

ipcMain.on("guest:notification-close", (event, payload) => {
  notificationCloses.push({ contentsId: event.sender.id, frame: event.senderFrame, payload });
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
    show: false,
    width: 1100,
    height: 850,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  }));
  bubbleWindow = trackWindow(new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  }));

  await run("sandboxed shell preload exposes the commsApp API", async () => {
    shellWindow = trackWindow(new BrowserWindow({
      show: false,
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
    assert.equal(harness.runtime(alpha.id).canGoBack, false);
    await alphaRecord.contents.executeJavaScript("location.hash = 'native-navigation'");
    await poll(() => alphaRecord.contents.getURL().endsWith("#native-navigation"), "in-page navigation was not retained");
    await poll(
      () => harness.runtimeEvents.at(-1)?.services[alpha.id]?.canGoBack === true,
      "in-page navigation did not publish back availability"
    );

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
    // The payload gained an id (to route the toast's click back), silent and kind.
    const notification = notifications.find((entry) => entry.serviceId === alpha.id);
    const { id: notificationId, ...payload } = notification.payload;
    assert.match(notificationId, /^[a-z0-9]+-\d+$/);
    assert.deepEqual(payload, {
      title: "Fixture notification",
      body: "Native bridge body",
      tag: "fixture-tag",
      silent: false,
      kind: "page"
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

  // D17: a grant is no longer a latch. Live tracks protect; after they end, only a grace period.
  await run("live capture tracks protect an inactive service until they end", async () => {
    const protectedService = service("media-protected", { sessionPartition: "persist:electron-media" });
    const anchor = service("media-anchor", { sessionPartition: "persist:electron-media-anchor" });
    const harness = createHarness([protectedService, anchor], protectedService.id, { idleTimeoutMs: 180, captureGraceMs: 400 });
    harness.manager.setPresentation({ host: fullWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const mediaRecord = harness.created[0];
    const contentsId = mediaRecord.contents.id;
    await waitForReady(mediaRecord.contents);

    // Legacy desktop capture skips the screen picker and is refused before any permission request.
    const requestsBefore = mediaRequests.length;
    const legacy = await mediaRecord.contents.executeJavaScript(`(async () => ({
      modern: await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop" } } })
        .then(() => "granted", (error) => error.name + ": " + error.message),
      callback: await new Promise((resolve) => navigator.webkitGetUserMedia(
        { audio: false, video: { chromeMediaSource: "screen" } },
        () => resolve("granted"),
        (error) => resolve(error.name)
      ))
    }))()`);
    assert.deepEqual(legacy, { modern: "NotAllowedError: Screen capture must use the screen picker.", callback: "NotAllowedError" });
    assert.equal(mediaRequests.length, requestsBefore);

    assert.equal(await mediaRecord.contents.executeJavaScript("window.fixture.startMedia()"), 1);
    await poll(
      () => mediaRequests.some((request) => request.contentsId === contentsId && request.permission === "media" && request.protectedService),
      "native media permission request did not reach the service manager"
    );
    await poll(() => captureReports.some((report) => report.contentsId === contentsId && report.live === 1), "live track was not reported");
    harness.select(anchor.id);
    assert.equal(harness.runtime(protectedService.id).protectionReason, "capture");
    await delay(900);
    assert.equal(mediaRecord.contents.isDestroyed(), false, "a live call must not be put to sleep");
    assert.equal(harness.runtime(protectedService.id).protectionReason, "capture");
    assert.ok(
      stateReplies.some((reply) => reply.contentsId === contentsId && reply.payload.captures === 1),
      "the page was asked at sleep time and still had a live track"
    );

    await mediaRecord.contents.executeJavaScript("window.fixture.stopMedia()");
    await poll(() => captureReports.some((report) => report.contentsId === contentsId && report.live === 0), "ended track was not reported");
    assert.equal(mediaRecord.contents.isDestroyed(), false, "the grace period follows the end of the call");
    await waitForDestroyed(mediaRecord.contents);
    assert.equal(harness.runtime(protectedService.id).status, "sleeping");
    harness.dispose();
    await Promise.all(harness.created.map((record) => waitForDestroyed(record.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("a draft emptied without an input event stops protecting at the next check", async () => {
    const drafting = service("draft-cleared", { sessionPartition: "persist:electron-draft" });
    const anchor = service("draft-anchor", { sessionPartition: "persist:electron-draft-anchor" });
    const harness = createHarness([drafting, anchor], drafting.id, { idleTimeoutMs: 250 });
    harness.manager.setPresentation({ host: fullWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const record = harness.created[0];
    const contentsId = record.contents.id;
    await waitForReady(record.contents);
    const typeInto = async (selector, text) => {
      await record.contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      record.contents.debugger.attach("1.3");
      await record.contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      await record.contents.debugger.sendCommand("Input.insertText", { text });
      record.contents.debugger.detach();
    };

    await typeInto("#search", "invoice");
    await delay(150);
    assert.equal(editReports.filter((report) => report.contentsId === contentsId).length, 0, "search boxes never hold a draft");
    await typeInto("#draft", "unsent reply");
    await poll(() => editReports.some((report) => report.contentsId === contentsId && report.dirty === true), "draft was not reported");

    harness.select(anchor.id);
    // Past the preload's own re-check after the last keystroke, so only the sleep-time query can notice.
    await delay(1200);
    assert.equal(record.contents.isDestroyed(), false, "an unsent draft keeps the page");
    assert.equal(harness.runtime(drafting.id).protectionReason, "edited");
    assert.ok(stateReplies.some((reply) => reply.contentsId === contentsId && reply.payload.dirty === true));

    // Chat apps empty their composer after sending without firing input events.
    await record.contents.executeJavaScript("document.querySelector('#draft').value = ''");
    await waitForDestroyed(record.contents);
    assert.ok(stateReplies.some((reply) => reply.contentsId === contentsId && reply.payload.dirty === false));
    assert.equal(editReports.some((report) => report.contentsId === contentsId && report.dirty === false), false,
      "the page sent no event; the check at sleep time found the empty composer");
    assert.equal(harness.runtime(drafting.id).status, "sleeping");
    harness.dispose();
    await Promise.all(harness.created.map((record) => waitForDestroyed(record.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("a draft in a script-created (about:blank) iframe editor protects the page", async () => {
    const drafting = service("draft-frame", { sessionPartition: "persist:electron-draft-frame" });
    const anchor = service("draft-frame-anchor", { sessionPartition: "persist:electron-draft-frame-anchor" });
    const harness = createHarness([drafting, anchor], drafting.id, { idleTimeoutMs: 250 });
    harness.manager.setPresentation({ host: fullWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const record = harness.created[0];
    const contentsId = record.contents.id;
    await waitForReady(record.contents);
    // An iframe rich-text editor (CKEditor 4, TinyMCE iframe mode): no src and filled by script, so
    // Chromium runs no preload in it and its input events never reach the page's window.
    await record.contents.executeJavaScript(`(() => {
      const frame = document.createElement("iframe");
      frame.id = "editor-frame";
      document.body.append(frame);
      const doc = frame.contentDocument;
      doc.open();
      doc.write('<!doctype html><body contenteditable="true"></body>');
      doc.close();
      return true;
    })()`);
    const editorBody = "document.querySelector('#editor-frame').contentDocument.body";
    record.contents.debugger.attach("1.3");
    await record.contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await record.contents.executeJavaScript(`${editorBody}.focus(); true`);
    await record.contents.debugger.sendCommand("Input.insertText", { text: "hello draft" });
    record.contents.debugger.detach();
    await poll(() => record.contents.executeJavaScript(`${editorBody}.textContent === "hello draft"`), "typing did not reach the iframe editor");
    await poll(() => editReports.some((report) => report.contentsId === contentsId && report.dirty === true), "the iframe draft was not reported");

    harness.select(anchor.id);
    await delay(1200);
    assert.equal(record.contents.isDestroyed(), false, "an unsent draft in an iframe editor keeps the page");
    assert.equal(harness.runtime(drafting.id).protectionReason, "edited");
    assert.ok(stateReplies.some((reply) => reply.contentsId === contentsId && reply.payload.dirty === true));

    // Emptied (sent): the next check at sleep time lets the page go.
    await record.contents.executeJavaScript(`${editorBody}.textContent = ""; true`);
    await waitForDestroyed(record.contents);
    assert.equal(harness.runtime(drafting.id).status, "sleeping");
    harness.dispose();
    await Promise.all(harness.created.map((item) => waitForDestroyed(item.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("the page's Notification API is replaced and routed through the host", async () => {
    const chat = service("notify-bridge", { sessionPartition: "persist:electron-notify" });
    const harness = createHarness([chat], chat.id);
    harness.manager.setPresentation({ host: fullWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const record = harness.created[0];
    const contents = record.contents;
    const contentsId = contents.id;
    await waitForReady(contents);
    const forNotification = (title) => notifications.find((entry) => entry.contentsId === contentsId && entry.payload.title === title);

    const api = await contents.executeJavaScript(`(async () => {
      let callbackValue = null;
      const promised = await Notification.requestPermission((value) => { callbackValue = value; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        permission: Notification.permission,
        promised,
        callbackValue,
        maxActions: Notification.maxActions,
        eventTarget: new Notification("Probe", { silent: true }) instanceof EventTarget,
        native: /\\[native code\\]/.test(Function.prototype.toString.call(Notification))
      };
    })()`);
    assert.deepEqual(api, { permission: "granted", promised: "granted", callbackValue: "granted", maxActions: 0, eventTarget: true, native: false });
    await poll(() => forNotification("Probe"), "the probe notification was not forwarded");
    assert.equal(forNotification("Probe").payload.silent, true);

    // A toast click (main → frame) reaches onclick and click listeners; dismissal reaches onclose.
    const index = await contents.executeJavaScript(`window.fixture.notifyTracked("New message", { body: "Hi", tag: "chat-7" })`);
    await poll(() => forNotification("New message"), "tracked notification was not forwarded");
    const tracked = forNotification("New message");
    await poll(() => contents.executeJavaScript(`window.fixture.record(${index}).shows === 1`), "show event did not fire");
    tracked.frame.send("guest:notification-event", { id: tracked.payload.id, type: "click" });
    await poll(
      () => contents.executeJavaScript(`(({ clicks, listenerClicks }) => clicks === 1 && listenerClicks === 1)(window.fixture.record(${index}))`),
      "the toast click was not forwarded to the page's Notification object"
    );
    assert.equal(await contents.executeJavaScript(`window.fixture.record(${index}).clickTarget`), true,
      "onclick sees the notification as event.target and event.currentTarget");
    tracked.frame.send("guest:notification-event", { id: "unknown-1", type: "click" });
    tracked.frame.send("guest:notification-event", { id: tracked.payload.id, type: "close" });
    await poll(() => contents.executeJavaScript(`window.fixture.record(${index}).closes === 1`), "toast dismissal did not reach onclose");

    // The page closing its own notification asks the host to close the toast.
    const closable = await contents.executeJavaScript(`window.fixture.notifyTracked("Closable", {})`);
    await poll(() => forNotification("Closable"), "closable notification was not forwarded");
    await contents.executeJavaScript(`window.fixture.closeTracked(${closable})`);
    await poll(
      () => notificationCloses.some((entry) => entry.contentsId === contentsId && entry.payload.id === forNotification("Closable").payload.id),
      "close() was not forwarded"
    );
    await poll(() => contents.executeJavaScript(`window.fixture.record(${closable}).closes === 1`), "close() did not fire close");

    // Service worker notifications take the same path.
    const workerResult = await contents.executeJavaScript(`ServiceWorkerRegistration.prototype.showNotification
      .call(null, "From worker", { body: "Push", tag: "w" }).then(() => "resolved", (error) => error.name)`);
    assert.equal(workerResult, "resolved");
    await poll(() => forNotification("From worker")?.payload.kind === "worker", "worker notification was not forwarded");

    // Same-origin frames may notify; cross-origin frames (ads, embeds) may not.
    await contents.executeJavaScript(`Promise.all([
      window.fixture.addFrame(${JSON.stringify(`${origin}/frame?name=same`)}),
      window.fixture.addFrame(${JSON.stringify(`${otherOrigin}/frame?name=other`)})
    ])`);
    const frameFor = (prefix) => contents.mainFrame.framesInSubtree.find((frame) => frame !== contents.mainFrame && frame.url.startsWith(prefix));
    const sameFrame = await poll(() => frameFor(`${origin}/frame`), "same-origin frame did not load");
    const otherFrame = await poll(() => frameFor(`${otherOrigin}/frame`), "cross-origin frame did not load");
    for (const frame of [sameFrame, otherFrame]) {
      await poll(() => frame.executeJavaScript("Boolean(window.__commsNotificationBridgeInstalled)"), "frame bridge did not install");
    }
    const sameIndex = await sameFrame.executeJavaScript(`window.fixture.notifyTracked("From same-origin frame", {})`);
    const otherIndex = await otherFrame.executeJavaScript(`window.fixture.notifyTracked("From cross-origin frame", {})`);
    await poll(() => forNotification("From same-origin frame"), "same-origin frame notification was not forwarded");
    const fromFrame = forNotification("From same-origin frame");
    assert.equal(fromFrame.frame.frameTreeNodeId, sameFrame.frameTreeNodeId, "the click is routed to the frame that raised it");
    fromFrame.frame.send("guest:notification-event", { id: fromFrame.payload.id, type: "click" });
    await poll(() => sameFrame.executeJavaScript(`window.fixture.record(${sameIndex}).clicks === 1`), "frame click was not forwarded");
    await poll(() => otherFrame.executeJavaScript(`window.fixture.record(${otherIndex}).errors === 1`), "cross-origin notification did not fail");
    assert.equal(forNotification("From cross-origin frame"), undefined);

    harness.dispose();
    await Promise.all(harness.created.map((item) => waitForDestroyed(item.contents)));
    assert.deepEqual(harness.errors, []);
  });

  await run("Notification.permission follows the session's permission check", async () => {
    const denied = service("notify-denied", { sessionPartition: "persist:electron-notify-denied" });
    session.fromPartition(denied.sessionPartition).setPermissionCheckHandler((_contents, permission) => permission !== "notifications");
    const harness = createHarness([denied], denied.id);
    harness.manager.setPresentation({ host: fullWindow, bounds: { x: 0, y: 0, width: 640, height: 480 }, obscured: false });
    const contents = harness.created[0].contents;
    await waitForReady(contents);
    const index = await contents.executeJavaScript(`window.fixture.notifyTracked("Not allowed", {})`);
    assert.equal(await contents.executeJavaScript("Notification.permission"), "denied");
    await poll(() => contents.executeJavaScript(`window.fixture.record(${index}).errors === 1`), "a denied notification did not fire error");
    const worker = await contents.executeJavaScript(`ServiceWorkerRegistration.prototype.showNotification
      .call(null, "Worker not allowed").then(() => "resolved", (error) => error.name)`);
    assert.equal(worker, "TypeError");
    await delay(100);
    assert.equal(notifications.some((entry) => entry.contentsId === contents.id), false);
    session.fromPartition(denied.sessionPartition).setPermissionCheckHandler(null);
    harness.dispose();
    await Promise.all(harness.created.map((item) => waitForDestroyed(item.contents)));
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
  frameStateQuery.dispose();
  for (const item of [server, otherServer]) {
    if (item) await new Promise((resolve) => item.close(resolve));
  }
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
    editReports: editReports.length,
    captureReports: captureReports.length,
    stateReplies: stateReplies.length,
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
