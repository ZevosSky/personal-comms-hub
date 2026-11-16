// Starts the actual packaged Linux client against a temporary profile and a local synthetic
// service. DevTools is enabled only for this test process, on the loopback interface.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.resolve(root, process.argv[2] || "release/linux-unpacked/comms-app");
const executeFile = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const clients = new Set();
const checks = [];
let child;
let runRoot;
let server;
let exitResult = null;
let childExit;
let stdout = "";
let stderr = "";

async function poll(check, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (exitResult) throw new Error(`Packaged client exited before ${message}: ${JSON.stringify(exitResult)}`);
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function devtoolsClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("DevTools connection timed out")); }, 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("DevTools connection failed")); }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(event.data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("DevTools connection closed"));
    }
    pending.clear();
  });
  const client = {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`DevTools ${method} timed out`));
        }, 8000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    async evaluate(expression) {
      const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result?.value;
    },
    close() { socket.close(); }
  };
  clients.add(client);
  return client;
}

async function screenshotSize(client) {
  const result = await client.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(result.data, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  assert.ok(size.width > 0 && size.height > 0, "the packaged page must paint a nonempty screenshot");
  return size;
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

let report;
try {
  assert.equal(process.platform, "linux", "Run packaged Linux checks on a native Linux host.");
  await access(executable, constants.X_OK);
  runRoot = await mkdtemp(path.join(os.tmpdir(), "comms-hub-packaged-"));
  const profile = path.join(runRoot, "profile");
  await mkdir(profile);
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><meta charset='utf-8'><title>Packaged Linux service</title><style>body{margin:0;background:#18344d;color:white;font:24px sans-serif}main{padding:24px}</style><main id='fixture'>Packaged Linux service<textarea aria-label='Draft'></textarea></main>");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const serviceId = "packaged-linux";
  await writeFile(path.join(profile, "comms-app-config.json"), JSON.stringify({
    services: [
      ...["gmail", "discord", "messenger", "slack", "teams"].map((id) => ({ id, isEnabled: false })),
      { id: serviceId, name: "Packaged Linux service", url: `${origin}/service`, isEnabled: true,
        sessionPartition: "persist:packaged-linux", keepAliveInBackground: false }
    ],
    ui: { activeServiceId: serviceId, windowMode: "dock", startMinimized: false, notificationsEnabled: false }
  }));
  const port = await freePort();
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
  child = spawn(executable, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"
  ], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Bound captured output; diagnostics from a misconfigured native dependency must not grow forever.
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-16000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
  childExit = new Promise((resolve) => {
    child.once("error", (error) => { exitResult = { error: error.message }; resolve(exitResult); });
    child.once("exit", (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
  });
  const getJson = async (endpoint) => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(2000) });
    assert.ok(response.ok, `DevTools ${endpoint} should respond`);
    return response.json();
  };
  const shellTarget = await poll(async () => (await getJson("/json/list")).find((target) =>
    target.type === "page" && /app\.asar(?:\/|%2F)dist(?:\/|%2F)index\.html/i.test(target.url)), "packaged shell target");
  const shellClient = await devtoolsClient(shellTarget.webSocketDebuggerUrl);
  await poll(() => shellClient.evaluate("Boolean(window.commsApp && document.querySelector('.service-viewport'))"), "production renderer and preload");
  const state = await shellClient.evaluate("window.commsApp.getState()");
  assert.equal(state.ui.activeServiceId, serviceId, "the executable must use the isolated test profile");
  assert.equal(state.ui.windowMode, "full", "Linux must recover a saved unsupported dock mode");
  assert.equal(state.capabilities.dockModeSupported, false);
  checks.push("packaged production renderer/preload and Linux dock fallback");
  await poll(async () => {
    const runtime = await shellClient.evaluate("window.commsApp.getServiceRuntime()");
    return runtime.services?.[serviceId]?.status === "active";
  }, "active local service");
  const viewport = await poll(async () => {
    const bounds = await shellClient.evaluate("(() => { const r = document.querySelector('.service-viewport').getBoundingClientRect(); return { width:r.width, height:r.height }; })()");
    return bounds.width > 0 && bounds.height > 0 && bounds;
  }, "nonempty production service viewport");
  const guestTarget = await poll(async () => (await getJson("/json/list")).find((target) => target.url === `${origin}/service`), "local service renderer target");
  const guestClient = await devtoolsClient(guestTarget.webSocketDebuggerUrl);
  const guestSize = await poll(async () => {
    const value = await guestClient.evaluate("({ ready:document.readyState==='complete' && Boolean(document.querySelector('#fixture')), width:innerWidth, height:innerHeight, nodeExposed:typeof require!=='undefined' })");
    return value.ready && value.width > 0 && value.height > 0 && value;
  }, "painted native service view");
  assert.equal(guestSize.nodeExposed, false, "guest content must not have Node.js access");
  const screenshots = { shell: await screenshotSize(shellClient), service: await screenshotSize(guestClient) };
  checks.push("local service loads and paints inside the packaged client without Node.js access");
  await guestClient.evaluate("document.cookie='packaged_smoke=retained; path=/'; true");
  await guestClient.send("Page.reload");
  await poll(() => guestClient.evaluate("document.readyState==='complete' && document.cookie.includes('packaged_smoke=retained')"), "service session cookie after reload");
  checks.push("service session survives reload");
  // The Linux desktop wrapper supplies an isolated D-Bus session and Dunst daemon. Verify
  // real libnotify delivery too: the guest's own close() withdraws only our uniquely named
  // notification, and Dunst's read-only history proves that the OS daemon received it.
  // Never use close-all/history-clear, which would disturb notifications on a user's desktop.
  const dunst = async (...args) => (await executeFile("dunstctl", args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout;
  const displayedBefore = Number((await dunst("count", "displayed")).trim());
  assert.ok(Number.isFinite(displayedBefore), "Dunst must report a numeric displayed count");
  await shellClient.evaluate("window.commsApp.setNotificationsEnabled(true)");
  const notificationMarker = `Packaged smoke ${randomUUID()}`;
  const raised = await guestClient.send("Runtime.evaluate", {
    expression: `(async () => {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return permission;
      window.__packagedNotification = new Notification(${JSON.stringify(notificationMarker)}, { body: 'Local packaged-client verification', silent: true });
      return permission;
    })()`,
    awaitPromise: true, returnByValue: true, userGesture: true
  });
  assert.equal(raised.result?.value, "granted", "the local service must be allowed to notify");
  await poll(async () => Number((await dunst("count", "displayed")).trim()) > displayedBefore,
    "native notification displayed by Dunst");
  await guestClient.evaluate("window.__packagedNotification.close(); true");
  await poll(async () => (await dunst("history")).includes(notificationMarker),
    "the service notification in the OS daemon's history");
  checks.push("guest notification reaches the native Linux notification daemon");
  const browser = await devtoolsClient((await getJson("/json/version")).webSocketDebuggerUrl);
  await browser.send("Browser.close").catch((error) => {
    if (!/connection closed/i.test(error.message)) throw error;
  });
  const outcome = await bounded(childExit, 10000, "Packaged client did not shut down cleanly");
  assert.equal(outcome.code, 0, "packaged client must exit cleanly");
  const startupLog = await readFile(path.join(profile, "startup.log"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  assert.doesNotMatch(startupLog, /Uncaught exception|Unhandled rejection|Failed to create main window|Failed to load.*shell|render-process-gone/i);
  checks.push("clean shutdown without fatal startup diagnostics");
  report = { ok: true, executable, checks, viewport, guestSize, screenshots };
} catch (error) {
  report = { ok: false, executable, checks, error: error.stack || String(error), stdout, stderr };
} finally {
  for (const client of clients) client.close();
  if (child && !exitResult) {
    child.kill("SIGTERM");
    await bounded(childExit, 3000, "Packaged client did not stop after SIGTERM").catch(() => {});
    if (!exitResult) { child.kill("SIGKILL"); await bounded(childExit, 3000, "Packaged client did not stop after SIGKILL").catch(() => {}); }
  }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (runRoot) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(runRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(runRoot).startsWith("comms-hub-packaged-")) {
      throw new Error(`Refusing to remove unexpected test directory: ${runRoot}`);
    }
    try { await rm(runRoot, { recursive: true, force: true }); }
    catch (error) { report = { ...report, ok: false, cleanupError: error.message }; }
  }
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
