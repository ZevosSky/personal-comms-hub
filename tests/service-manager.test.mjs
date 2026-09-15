import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { clampServiceZoom, createServiceManager } from "../electron/serviceManager.js";

const service = (id, extra = {}) => ({ id, url: "https://mail.google.com/mail/u/0/", isEnabled: true,
  sessionPartition: `persist:${id}`, keepAliveInBackground: false, zoomFactor: 1, ...extra });

function harness(initial = [service("a"), service("b")]) {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  const views = [];
  const errors = [];
  const titles = [];
  const state = { services: initial, ui: { activeServiceId: initial[0]?.id, memorySaverEnabled: true } };
  const manager = createServiceManager({
    now: () => time,
    setTimeoutFn: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeoutFn: (id) => timers.delete(id),
    onError: (id, error) => errors.push({ id, error }),
    onTitle: (id, title) => titles.push({ id, title }),
    createView: (config) => {
      const wc = new EventEmitter();
      Object.assign(wc, {
        id: views.length + 1, dead: false, audible: false, closeMode: "close", url: "", loads: [], zooms: [], closes: [],
        isDestroyed() { return this.dead; },
        isCurrentlyAudible() { return this.audible; },
        getURL() { return this.url; },
        setZoomFactor(zoom) { this.zooms.push(zoom); },
        loadURL(url) { this.url = url; this.loads.push(url); return Promise.resolve(); },
        reload() { this.reloads = (this.reloads || 0) + 1; },
        destroyNow() { this.dead = true; this.emit("destroyed"); },
        close(options) {
          this.closes.push(options);
          if (!options.waitForBeforeUnload || this.closeMode === "close") this.destroyNow();
          else if (this.closeMode === "veto") this.emit("will-prevent-unload", {
            preventDefault() { throw new Error("A veto must never be overridden"); }
          });
        }
      });
      const view = { webContents: wc, config, setBounds(bounds) { this.bounds = bounds; },
        setBorderRadius(radius) { this.radius = radius; } };
      views.push(view);
      return view;
    }
  });
  const sync = () => manager.sync(state);
  const select = (id) => { state.ui.activeServiceId = id; sync(); };
  const tick = (duration) => {
    const until = time + duration;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    time = until;
  };
  const runtime = (id) => manager.getRuntimeState().services[id];
  sync();
  return { manager, state, views, errors, titles, timers, sync, select, tick, runtime };
}

test("same-domain service IDs own distinct views and preserve supplied partitions", () => {
  const h = harness([service("personal"), service("work", { sessionPartition: "persist:existing-work" })]);
  h.select("work");
  h.select("personal");
  assert.equal(h.views.length, 2);
  assert.equal(h.views[1].config.sessionPartition, "persist:existing-work");
  assert.equal(h.runtime("personal").webContentsId, 1);
  assert.equal(h.manager.getServiceIdForContents(2), "work");
  assert.equal(h.manager.getServiceIdForContents(500), null);
  assert.equal(h.views[0].webContents.loads.length, 1);
  h.manager.dispose();
});

test("idle timeout is exactly ten minutes and recreation restores the last safe URL", () => {
  const h = harness();
  h.views[0].webContents.emit("did-navigate-in-page", {}, "https://mail.google.com/mail/u/0/#draft", true);
  h.views[0].webContents.url = "https://mail.google.com/mail/u/0/#draft";
  h.select("b");
  h.tick(599999);
  assert.equal(h.views[0].webContents.dead, false);
  h.tick(1);
  assert.equal(h.views[0].webContents.dead, true);
  assert.equal(h.runtime("a").status, "sleeping");
  assert.equal(h.manager.getServiceIdForContents(1), null);
  h.select("a");
  assert.equal(h.views.length, 3);
  assert.deepEqual(h.views[2].webContents.loads, ["https://mail.google.com/mail/u/0/#draft"]);
  h.manager.dispose();
});

test("arbitrarily many inactive services remain for their full timeout, with no tab cap", () => {
  const h = harness(Array.from({ length: 25 }, (_, i) => service(String(i))));
  for (let i = 1; i < 25; i++) h.select(String(i));
  assert.equal(h.views.length, 25);
  h.tick(599999);
  assert.equal(h.views.filter((view) => !view.webContents.dead).length, 25);
  h.tick(1);
  assert.equal(h.views.filter((view) => !view.webContents.dead).length, 1);
  h.manager.dispose();
});

test("pins are loaded and retained; saver off retains visited services, then resumes idle deadlines", () => {
  const h = harness([service("a"), service("b", { keepAliveInBackground: true }), service("c")]);
  assert.equal(h.views.length, 2);
  h.select("c");
  h.state.ui.memorySaverEnabled = false;
  h.sync();
  h.tick(1200000);
  assert.equal(h.views.some((view) => view.webContents.dead), false);
  h.state.ui.memorySaverEnabled = true;
  h.sync();
  h.tick(0);
  assert.equal(h.views[0].webContents.dead, true);
  assert.equal(h.views[1].webContents.dead, false);
  h.state.services = h.state.services.map((item) => ({ ...item, keepAliveInBackground: false }));
  h.sync();
  h.tick(0);
  assert.equal(h.views[1].webContents.dead, true);
  h.manager.dispose();
});

test("reparenting, resizing and modal obscuring preserve the native contents", () => {
  const h = harness();
  const host = () => ({ children: new Set(), isDestroyed: () => false,
    get contentView() { return { addChildView: (v) => this.children.add(v), removeChildView: (v) => this.children.delete(v) }; } });
  const full = host();
  const bubble = host();
  const bounds = { x: 20, y: 40, width: 700, height: 600 };
  h.manager.setPresentation({ host: full, bounds, obscured: false, borderRadius: 12 });
  assert.equal(full.children.size, 1);
  h.manager.setPresentation({ host: bubble, bounds: { ...bounds, width: 500 } });
  assert.equal(full.children.size, 0);
  assert.equal(bubble.children.size, 1);
  h.manager.setPresentation({ obscured: true });
  assert.equal(bubble.children.size, 0);
  h.manager.setPresentation({ obscured: false });
  assert.equal(bubble.children.size, 1);
  assert.equal(h.views.length, 1);
  assert.equal(h.views[0].webContents.loads.length, 1);
  assert.equal(h.views[0].radius, 12);
  h.manager.dispose();
  assert.equal(bubble.children.size, 0);
});

test("beforeunload veto retains the same page, does not force or repeatedly retry", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  wc.closeMode = "veto";
  h.select("b");
  h.tick(600000);
  assert.equal(h.runtime("a").protectionReason, "beforeunload");
  h.tick(3600000);
  h.sync();
  h.tick(0);
  assert.equal(wc.closes.length, 1);
  assert.equal(wc.dead, false);
  h.select("a");
  assert.equal(h.views.length, 2);
  h.manager.dispose();
  assert.equal(wc.dead, true);
});

test("activation during pending close never creates two views and recovers after destruction", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  wc.closeMode = "pending";
  h.select("b");
  h.tick(600000);
  wc.emit("unresponsive");
  h.select("a");
  h.tick(3600000);
  assert.equal(h.views.length, 2);
  assert.equal(wc.closes.length, 1);
  assert.equal(h.runtime("a").status, "closing");
  wc.destroyNow();
  assert.equal(h.views.length, 3);
  assert.equal(h.runtime("a").webContentsId, 3);
  assert.equal(h.manager.getServiceIdForContents(1), null);
  h.manager.dispose();
});

test("edited and granted-media latches survive SPA navigation, reset only after committed main navigation", () => {
  for (const protection of ["markEdited", "protectMedia"]) {
    const h = harness();
    const wc = h.views[0].webContents;
    assert.equal(h.manager[protection](wc.id), true);
    assert.equal(h.manager[protection](10000), false);
    h.select("b");
    wc.emit("did-navigate-in-page", {}, "https://mail.google.com/#sent", true);
    wc.emit("did-frame-navigate", {}, "https://mail.google.com/frame", 200, "OK", false);
    h.tick(600000);
    assert.equal(wc.dead, false);
    h.select("a");
    h.manager.refreshActive();
    h.select("b");
    h.tick(600000);
    assert.equal(wc.dead, false, "reload request alone cannot clear the latch");
    wc.emit("did-navigate", {}, "https://mail.google.com/new-document");
    h.tick(0);
    assert.equal(wc.dead, true);
    h.manager.dispose();
  }
});

test("playing, audible, and unresponsive pages are retained until their protection ends", () => {
  for (const mode of ["playing", "audible", "unresponsive"]) {
    const h = harness();
    const wc = h.views[0].webContents;
    if (mode === "playing") wc.emit("media-started-playing");
    if (mode === "audible") { wc.audible = true; wc.emit("audio-state-changed", {}); }
    if (mode === "unresponsive") wc.emit("unresponsive");
    h.select("b");
    h.tick(600000);
    assert.equal(wc.dead, false);
    if (mode === "playing") wc.emit("media-paused");
    if (mode === "audible") { wc.audible = false; wc.emit("audio-state-changed", {}); }
    if (mode === "unresponsive") wc.emit("responsive");
    h.tick(0);
    assert.equal(wc.dead, true);
    h.manager.dispose();
  }
});

test("only active pages apply clamped zoom, including shared-session pages", () => {
  const h = harness([service("a", { zoomFactor: 4, sessionPartition: null }),
    service("b", { zoomFactor: 0.1, sessionPartition: null, keepAliveInBackground: true })]);
  assert.equal(h.views[0].webContents.zooms.at(-1), 2);
  assert.equal(h.views[1].webContents.zooms.length, 0);
  h.select("b");
  assert.equal(h.views[1].webContents.zooms.at(-1), 0.5);
  const count = h.views[0].webContents.zooms.length;
  h.views[0].webContents.emit("dom-ready");
  h.views[0].webContents.emit("did-navigate", {}, "https://mail.google.com/other");
  assert.equal(h.views[0].webContents.zooms.length, count);
  assert.equal(clampServiceZoom("bad"), 1);
  h.manager.dispose();
});

test("removal, disabling and disposal release contents, listeners, and timers", () => {
  const h = harness();
  h.select("b");
  const wc = h.views[0].webContents;
  wc.closeMode = "veto";
  h.state.services = h.state.services.filter((item) => item.id !== "a");
  h.sync();
  assert.equal(wc.dead, true);
  assert.equal(wc.eventNames().length, 0);
  assert.equal(h.runtime("a"), undefined);
  h.state.services = [service("b", { isEnabled: false })];
  h.sync();
  assert.equal(h.views[1].webContents.dead, true);
  h.manager.dispose();
  assert.equal(h.timers.size, 0);
  h.sync();
  assert.equal(h.views.length, 2);
});

test("main-frame load failures report an error without duplicate creation and refresh retries", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  wc.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", wc.url, true);
  h.sync();
  assert.equal(h.views.length, 1);
  assert.equal(h.runtime("a").error, "NAME_NOT_RESOLVED");
  assert.equal(h.manager.refreshActive(), true);
  assert.equal(wc.reloads, 1);
  wc.emit("page-title-updated", {}, "Inbox (2)");
  assert.deepEqual(h.titles, [{ id: "a", title: "Inbox (2)" }]);
  h.manager.dispose();
});

test("a failed view factory waits for explicit refresh instead of retrying every state update", () => {
  let attempts = 0;
  const manager = createServiceManager({ createView: () => { attempts++; throw new Error("view unavailable"); } });
  const state = { services: [service("a")], ui: { activeServiceId: "a" } };
  manager.sync(state);
  manager.sync(state);
  assert.equal(attempts, 1);
  assert.equal(manager.getRuntimeState().services.a.error, "view unavailable");
  manager.refreshActive();
  assert.equal(attempts, 2);
  manager.dispose();
});

test("turning saver off while close is pending restores the visited page when close finishes", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  wc.closeMode = "pending";
  h.select("b");
  h.tick(600000);
  h.state.ui.memorySaverEnabled = false;
  h.sync();
  assert.equal(h.views.length, 2);
  wc.destroyNow();
  assert.equal(h.views.length, 3);
  assert.equal(h.runtime("a").webContentsId, 3);
  h.manager.dispose();
});

test("saving a corrected URL recovers an unloaded error without a second reload", () => {
  const h = harness([service("a", { url: "invalid" })]);
  assert.equal(h.runtime("a").status, "error");
  assert.equal(h.views[0].webContents.dead, true);
  h.state.services = [service("a")];
  h.sync();
  assert.equal(h.views.length, 2);
  assert.equal(h.runtime("a").error, null);
  assert.deepEqual(h.views[1].webContents.loads, [service("a").url]);
  h.manager.dispose();
});
