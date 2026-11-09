import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { clampServiceZoom, createServiceManager } from "../electron/serviceManager.js";

const service = (id, extra = {}) => ({ id, url: "https://mail.google.com/mail/u/0/", isEnabled: true,
  sessionPartition: `persist:${id}`, keepAliveInBackground: false, zoomFactor: 1, ...extra });

function harness(initial = [service("a"), service("b")], options = {}) {
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
    ...options,
    createView: (config) => {
      const wc = new EventEmitter();
      Object.assign(wc, {
        id: views.length + 1, dead: false, audible: false, closeMode: "close", url: "", loads: [], zooms: [], closes: [],
        history: { back: false, forward: false, wentBack: 0 },
        get navigationHistory() {
          const history = this.history;
          return { canGoBack: () => history.back, canGoForward: () => history.forward, goBack: () => { history.wentBack += 1; } };
        },
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

test("a page that had the keyboard hands it to its window when it is covered or replaced", () => {
  const h = harness();
  let focuses = 0;
  let visible = true;
  const children = new Set();
  const host = {
    isDestroyed: () => false,
    isVisible: () => visible,
    webContents: { focus: () => { focuses += 1; } },
    contentView: { addChildView: (v) => children.add(v), removeChildView: (v) => children.delete(v) }
  };
  const bounds = { x: 0, y: 0, width: 700, height: 600 };
  h.manager.setPresentation({ host, bounds, obscured: false });
  const page = h.views[0].webContents;
  page.isFocused = () => false;
  h.manager.setPresentation({ obscured: true });
  assert.equal(focuses, 0, "a page without focus changes nothing");
  h.manager.setPresentation({ obscured: false });
  page.isFocused = () => true;
  h.manager.setPresentation({ obscured: true });
  assert.equal(children.size, 0);
  assert.equal(focuses, 1, "the window's own page takes the keyboard (e.g. for the screen-share picker)");
  h.manager.setPresentation({ obscured: false });
  h.select("b");
  assert.equal(focuses, 2, "selecting another app from inside the page keeps the keyboard in the window");
  h.views[1].webContents.isFocused = () => true;
  visible = false;
  h.manager.setPresentation({ obscured: true });
  assert.equal(focuses, 2, "a hidden window is never focused");
  h.manager.dispose();
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

// D17: a draft protects only while an editor still holds it; it is not a latch any more.
test("a reported draft survives SPA navigation and clears when the frame reports it empty", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  assert.equal(h.manager.setEdited(wc.id, 7, true), true);
  assert.equal(h.manager.setEdited(10000, 7, true), false, "unknown pages are ignored");
  h.select("b");
  wc.emit("did-navigate-in-page", {}, "https://mail.google.com/#sent", true);
  h.tick(600000);
  assert.equal(wc.dead, false);
  assert.equal(h.runtime("a").protectionReason, "edited");
  h.manager.setEdited(wc.id, 9, false);
  assert.equal(h.runtime("a").protectionReason, "edited", "another frame's report never clears this one");
  h.manager.setEdited(wc.id, 7, false);
  h.tick(0);
  assert.equal(wc.dead, true, "a cleared draft lets the overdue service sleep at once");
  h.manager.dispose();
});

test("a committed main-frame navigation clears drafts and capture reported by the old document", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  h.manager.setEdited(wc.id, 1, true);
  h.manager.setCapture(wc.id, 2, 1);
  h.select("b");
  h.tick(600000);
  assert.equal(wc.dead, false);
  wc.emit("did-navigate", {}, "https://mail.google.com/new-document");
  h.tick(0);
  assert.equal(wc.dead, true);
  h.manager.dispose();
});

test("at sleep time drafts are re-checked; a draft cleared without an event no longer protects", async () => {
  const replies = [];
  const queries = [];
  const h = harness(undefined, {
    queryFrames: async (contents, keys) => {
      queries.push({ id: contents.id, keys });
      return replies.shift() ?? new Map();
    }
  });
  const wc = h.views[0].webContents;
  h.manager.setEdited(wc.id, 3, true);
  h.manager.setEdited(wc.id, 4, true);
  h.select("b");
  replies.push(new Map([[3, { dirty: true, captures: 0 }], [4, null]]));
  h.tick(600000);
  await flush();
  assert.deepEqual(queries, [{ id: wc.id, keys: [3, 4] }]);
  assert.equal(wc.dead, false, "the editor still holds text");
  assert.equal(h.runtime("a").protectionReason, "edited");
  h.tick(599999);
  await flush();
  assert.equal(queries.length, 1, "a confirmed draft is not asked again within the idle period");
  replies.push(new Map([[3, { dirty: true, captures: 0 }]]));
  h.tick(1);
  await flush();
  assert.equal(queries.length, 2, "it is asked again one idle period later");
  assert.equal(wc.dead, false);

  // A report from the page (e.g. focus moved after the composer was emptied) asks at once.
  h.manager.setEdited(wc.id, 5, false);
  replies.push(new Map([[3, { dirty: false, captures: 0 }]]));
  h.tick(0);
  await flush();
  assert.deepEqual(queries.at(-1).keys, [3]);
  h.tick(0);
  assert.equal(wc.dead, true);
  h.manager.dispose();
});

test("an answer from a document that navigated away while being asked is ignored", async () => {
  let answer;
  const h = harness(undefined, { queryFrames: () => new Promise((resolve) => { answer = resolve; }) });
  const wc = h.views[0].webContents;
  h.manager.setEdited(wc.id, 3, true);
  h.select("b");
  h.tick(600000);
  await flush();
  assert.equal(typeof answer, "function", "the page was asked");
  wc.emit("did-navigate", {}, "https://mail.google.com/other");
  answer(new Map([[3, { dirty: true, captures: 0 }]]));
  await flush();
  h.tick(0);
  assert.equal(wc.dead, true, "the old document's draft does not protect the new one");
  h.manager.dispose();
});

test("frames that do not answer keep their last report", async () => {
  const h = harness(undefined, { queryFrames: async () => new Map() });
  const wc = h.views[0].webContents;
  h.manager.setEdited(wc.id, 3, true);
  h.select("b");
  h.tick(600000);
  await flush();
  h.tick(0);
  assert.equal(wc.dead, false);
  assert.equal(h.runtime("a").protectionReason, "edited");
  h.manager.dispose();
});

test("live capture protects; after the tracks end it lasts only the grace period", () => {
  const h = harness(undefined, { captureGraceMs: 30000 });
  const wc = h.views[0].webContents;
  h.manager.setCapture(wc.id, 1, 2);
  h.select("b");
  h.tick(3600000);
  assert.equal(wc.dead, false);
  assert.equal(h.runtime("a").protectionReason, "capture");
  h.manager.setCapture(wc.id, 1, 0);
  assert.equal(h.runtime("a").protectionReason, "capture", "grace after the call ends");
  h.tick(29999);
  assert.equal(wc.dead, false);
  h.tick(1);
  assert.equal(wc.dead, true);
  h.manager.dispose();
});

test("a granted permission protects only for the grace period unless capture starts", () => {
  const h = harness(undefined, { captureGraceMs: 30000 });
  const wc = h.views[0].webContents;
  assert.equal(h.manager.protectMedia(wc.id), true);
  assert.equal(h.manager.protectMedia(10000), false);
  h.select("b");
  h.tick(599999);
  assert.equal(h.runtime("a").protectionReason, null, "the grace period has long ended");
  h.tick(1);
  assert.equal(wc.dead, true, "a grant alone never latches");
  h.manager.dispose();

  const late = harness(undefined, { captureGraceMs: 30000 });
  const page = late.views[0].webContents;
  late.select("b");
  late.tick(599000);
  late.manager.protectMedia(page.id);
  late.tick(1000);
  assert.equal(page.dead, false, "the idle deadline waits for the grace period");
  assert.equal(late.runtime("a").protectionReason, "capture");
  late.tick(29000);
  assert.equal(page.dead, true);
  late.manager.dispose();
});

test("live capture reported by a frame that has gone is dropped at sleep time", async () => {
  const h = harness(undefined, { captureGraceMs: 1000, queryFrames: async () => new Map([[8, null]]) });
  const wc = h.views[0].webContents;
  h.manager.setCapture(wc.id, 8, 1);
  h.select("b");
  h.tick(600000);
  await flush();
  assert.equal(h.runtime("a").protectionReason, "capture");
  h.tick(1000);
  assert.equal(wc.dead, true);
  h.manager.dispose();
});

test("open popups protect their opener until they close", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  const closePopup = h.manager.protectPopup(wc.id);
  h.select("b");
  h.tick(600000);
  assert.equal(wc.dead, false);
  assert.equal(h.runtime("a").protectionReason, "popup");
  closePopup();
  closePopup();
  h.tick(0);
  assert.equal(wc.dead, true);
  assert.equal(typeof h.manager.protectPopup(10000), "function");
  h.manager.dispose();
});

test("the idle timeout follows ui.memorySaverTimeoutMinutes", () => {
  const h = harness();
  h.state.ui.memorySaverTimeoutMinutes = 5;
  h.select("b");
  h.tick(299999);
  assert.equal(h.views[0].webContents.dead, false);
  h.tick(1);
  assert.equal(h.views[0].webContents.dead, true);
  h.state.ui.memorySaverTimeoutMinutes = 30;
  h.select("a");
  h.select("b");
  h.tick(1799999);
  assert.equal(h.views[2].webContents.dead, false);
  h.tick(1);
  assert.equal(h.views[2].webContents.dead, true);
  h.manager.dispose();
});

test("sleep now closes a loaded background app; a pinned one stays asleep until selected", () => {
  const h = harness([service("a"), service("b", { keepAliveInBackground: true }), service("c")]);
  assert.equal(h.views.length, 2);
  assert.equal(h.manager.sleep("a"), false, "the selected app never sleeps");
  assert.equal(h.manager.sleep("c"), false, "nothing loaded");
  assert.equal(h.manager.sleep("b"), true);
  assert.equal(h.views[1].webContents.dead, true);
  assert.deepEqual(h.views[1].webContents.closes, [{ waitForBeforeUnload: true }]);
  assert.equal(h.runtime("b").status, "sleeping");
  assert.equal(h.runtime("b").manuallySlept, true);
  h.sync();
  h.state.ui.memorySaverEnabled = false;
  h.sync();
  assert.equal(h.views.length, 2, "pinned and saver-off apps are not reloaded behind the user's back");
  h.select("b");
  assert.equal(h.views.length, 3);
  assert.equal(h.runtime("b").manuallySlept, false);
  h.select("a");
  assert.equal(h.manager.sleep("b"), true);
  h.manager.dispose();
});

test("sleep now is refused while the app has a popup open, unless forced", () => {
  const h = harness();
  h.select("b");
  const wc = h.views[0].webContents;
  const closePopup = h.manager.protectPopup(wc.id);
  assert.equal(h.manager.sleep("a"), false, "sleeping would destroy the popup without asking");
  assert.equal(wc.dead, false);
  assert.deepEqual(wc.closes, []);
  assert.equal(h.runtime("a").manuallySlept, false);
  assert.equal(h.runtime("a").protectionReason, "popup");
  closePopup();
  assert.equal(h.manager.sleep("a"), true, "once the popup has closed the app sleeps");
  assert.equal(wc.dead, true);
  assert.equal(h.runtime("a").manuallySlept, true);

  h.select("a");
  h.select("b");
  const reloaded = h.views.at(-1).webContents;
  h.manager.protectPopup(reloaded.id);
  assert.equal(h.manager.sleep("a", { force: true }), true, "forced");
  assert.equal(reloaded.dead, true);
  h.manager.dispose();
});

test("sleep now respects a beforeunload veto and closes a hung page without asking", () => {
  const h = harness();
  h.select("b");
  const wc = h.views[0].webContents;
  wc.closeMode = "veto";
  assert.equal(h.manager.sleep("a"), true);
  assert.equal(wc.dead, false);
  assert.equal(h.runtime("a").protectionReason, "beforeunload");
  assert.equal(h.runtime("a").manuallySlept, false);
  wc.emit("unresponsive");
  wc.closeMode = "pending";
  h.manager.sleep("a");
  assert.deepEqual(wc.closes.at(-1), { waitForBeforeUnload: false });
  assert.equal(wc.dead, true);
  h.manager.dispose();
});

test("network load failures are retried with backoff until a load succeeds", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  wc.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", wc.url, true);
  assert.equal(h.runtime("a").status, "error");
  assert.equal(h.runtime("a").retryAt, 5000);
  h.tick(4999);
  assert.equal(wc.reloads, undefined);
  h.tick(1);
  assert.equal(wc.reloads, 1);
  assert.equal(h.runtime("a").error, null);
  assert.equal(h.runtime("a").retryAt, null);
  wc.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", wc.url, true);
  assert.equal(h.runtime("a").retryAt, 5000 + 15000, "the second attempt waits longer");
  wc.emit("did-navigate", {}, "https://mail.google.com/mail/u/0/");
  assert.equal(h.runtime("a").retryAt, null);
  wc.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", wc.url, true);
  assert.equal(h.runtime("a").retryAt, 5000 + 5000, "a successful load resets the backoff");
  wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", wc.url, true);
  wc.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", "https://ads.example/", false);
  h.manager.dispose();
  assert.equal(h.timers.size, 0);
});

test("only network failures retry, and retryFailed reloads them at once", () => {
  const h = harness([service("a"), service("b", { keepAliveInBackground: true })]);
  const [first, second] = h.views.map((view) => view.webContents);
  first.emit("did-fail-load", {}, -501, "ERR_INSECURE_RESPONSE", first.url, true);
  second.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", second.url, true);
  assert.equal(h.runtime("a").retryAt, null);
  assert.equal(h.manager.retryFailed(), 1);
  assert.equal(first.reloads, undefined);
  assert.equal(second.reloads, 1);
  assert.equal(h.runtime("b").retryAt, null);
  h.manager.dispose();
});

test("a load cut off by sleep (ERR_NETWORK_IO_SUSPENDED) counts as a network failure", () => {
  const h = harness([service("a", { keepAliveInBackground: true }), service("b")]);
  const wc = h.views[0].webContents;
  wc.emit("did-fail-load", {}, -12, "ERR_NETWORK_IO_SUSPENDED", wc.url, true);
  assert.equal(h.runtime("a").status, "error");
  assert.equal(h.runtime("a").retryAt, 5000, "a backoff retry is scheduled");
  assert.equal(h.manager.retryFailed(), 1, "resume retries it at once");
  assert.equal(wc.reloads, 1);
  assert.equal(h.runtime("a").retryAt, null);
  h.manager.dispose();
});

test("a crashed active or pinned page is restarted, a bounded number of times", () => {
  const h = harness([service("a"), service("b", { keepAliveInBackground: true }), service("c")]);
  h.select("c");
  h.select("a");
  const crash = (contents) => contents.emit("render-process-gone", {}, { reason: "oom" });
  crash(h.views[2].webContents);
  assert.equal(h.runtime("c").status, "error");
  assert.equal(h.runtime("c").retryAt, null, "a background unpinned page is not restarted");
  crash(h.views[1].webContents);
  assert.equal(h.views[1].webContents.dead, true, "the dead page is released");
  assert.equal(h.runtime("b").status, "error");
  assert.match(h.runtime("b").error, /oom.*Reconnecting/);
  assert.equal(h.runtime("b").retryAt, 2000);
  h.tick(2000);
  assert.equal(h.views.length, 4);
  assert.equal(h.runtime("b").status, "loading");
  crash(h.views[3].webContents);
  h.tick(15000);
  crash(h.views[4].webContents);
  h.tick(60000);
  assert.equal(h.views.length, 6);
  crash(h.views[5].webContents);
  assert.equal(h.runtime("b").retryAt, null, "a fourth crash in half an hour waits for Refresh");
  assert.match(h.runtime("b").error, /Refresh to reconnect/);
  h.tick(600000);
  assert.equal(h.views.length, 6);
  h.select("c");
  assert.equal(h.views.length, 7, "selecting a crashed page restarts it");
  assert.equal(h.runtime("c").error, null);
  h.manager.dispose();
  assert.equal(h.timers.size, 0);
});

test("runtime reports back/forward availability, updated on in-page navigation; goHome loads the service URL", () => {
  const h = harness();
  const wc = h.views[0].webContents;
  assert.deepEqual([h.runtime("a").canGoBack, h.runtime("a").canGoForward], [false, false]);
  wc.history.back = true;
  wc.emit("did-navigate-in-page", {}, "https://mail.google.com/mail/u/0/#sent", true);
  assert.equal(h.runtime("a").canGoBack, true);
  assert.equal(h.runtime("a").lastUrl, "https://mail.google.com/mail/u/0/#sent");
  assert.equal(h.manager.goBack(), true);
  assert.equal(wc.history.wentBack, 1);
  assert.equal(h.manager.goForward(), false);
  assert.equal(h.manager.goHome(), true);
  assert.equal(wc.loads.at(-1), service("a").url);
  assert.equal(h.manager.goHome("missing"), false);
  assert.equal(h.manager.getContents(), wc);
  assert.deepEqual(Object.keys(h.manager.getLiveContents()), ["a"]);
  h.manager.dispose();
});

test("the landing URL is where the home address ends up through server redirects only (D10)", () => {
  const home = "https://teams.microsoft.com/v2/";
  const h = harness([service("a", { url: home }), service("b")]);
  const wc = h.views[0].webContents;
  const start = (url, extra = {}) => wc.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false, initiator: null, ...extra });
  const redirect = (url) => wc.emit("did-redirect-navigation", { url, isMainFrame: true, isSameDocument: false });
  const commit = (url) => wc.emit("did-navigate", {}, url);
  assert.equal(h.manager.getLandingUrl(wc.id), null);

  // The first load of the home address: its server redirects are followed.
  start(home);
  wc.emit("did-start-navigation", { url: "https://ads.example/frame", isMainFrame: false });
  start("https://teams.microsoft.com/v2/#old-page", { isSameDocument: true, initiator: {} });
  redirect("https://teams.cloud.microsoft/v2/");
  commit("https://teams.cloud.microsoft/v2/");
  assert.equal(h.manager.getLandingUrl(wc.id), "https://teams.cloud.microsoft/v2/");

  // Later navigations (a link, a script, history, a reload) never extend it.
  start("https://unrelated.example/", { initiator: {} });
  commit("https://unrelated.example/");
  start("https://unrelated.example/");
  commit("https://unrelated.example/");
  assert.equal(h.manager.getLandingUrl(wc.id), "https://teams.cloud.microsoft/v2/");

  // goHome records again; a page-started navigation during the load drops it.
  assert.equal(h.manager.goHome(), true);
  start("https://unrelated.example/next", { initiator: {} });
  commit("https://unrelated.example/next");
  assert.equal(h.manager.getLandingUrl(wc.id), "https://teams.cloud.microsoft/v2/", "the earlier landing stays");
  assert.equal(h.manager.goHome(), true);
  start(home);
  redirect("https://login.example/");
  wc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://login.example/", true);
  start("https://login.example/");
  commit("https://login.example/");
  assert.equal(h.manager.getLandingUrl(wc.id), "https://teams.cloud.microsoft/v2/", "a failed home load records nothing");

  // A load that did not start at the home address (history after an armed load) records nothing.
  assert.equal(h.manager.goHome(), true);
  start("https://unrelated.example/back");
  commit("https://unrelated.example/back");
  assert.equal(h.manager.getLandingUrl(wc.id), "https://teams.cloud.microsoft/v2/");

  // A new address forgets the old landing.
  h.state.services = [service("a", { url: "https://chat.example/" }), service("b")];
  h.sync();
  assert.equal(h.manager.getLandingUrl(wc.id), null);
  start("https://chat.example/");
  commit("https://chat.example/");
  assert.equal(h.manager.getLandingUrl(wc.id), "https://chat.example/");
  assert.equal(h.manager.getLandingUrl(999), null);
  h.manager.dispose();
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
