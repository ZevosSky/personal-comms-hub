import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createDesktopNotifier,
  overflowBody,
  sanitizeGuestNotification,
  shouldShowDesktopToast,
  toastTitle
} from "../electron/desktopNotifications.js";

function harness(options = {}) {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  const toasts = [];
  const clicks = [];
  const closes = [];
  const logs = [];
  class FakeToast extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.shown = 0;
      this.closed = 0;
      toasts.push(this);
    }
    show() { this.shown += 1; }
    close() { this.closed += 1; }
  }
  const notifier = createDesktopNotifier({
    createToast: (toastOptions) => new FakeToast(toastOptions),
    onClick: (click) => clicks.push(click),
    onPageClose: (target) => closes.push(target),
    now: () => time,
    setTimeoutFn: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeoutFn: (id) => timers.delete(id),
    log: (...args) => logs.push(args),
    ...options
  });
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
  return { notifier, toasts, clicks, closes, logs, timers, tick };
}

const note = (extra = {}) => ({ serviceId: "discord", serviceName: "Discord", title: "Bob", body: "hey", ...extra });

test("guest payloads are validated and trimmed", () => {
  assert.deepEqual(sanitizeGuestNotification({ id: "abc-1", title: " Hi\u0007 ", body: "x".repeat(2000), tag: "t", silent: true, kind: "worker" }), {
    id: "abc-1", title: "Hi", body: "x".repeat(1000), tag: "t", silent: true, kind: "worker"
  });
  assert.equal(sanitizeGuestNotification({ id: "abc-1", title: "Hi" }).kind, "page");
  const multiline = sanitizeGuestNotification({ id: "abc-1", title: "Bob\n\n\tWindows Security", body: "line 1\nline 2" });
  assert.equal(multiline.title, "Bob Windows Security", "titles are flattened to one line");
  assert.equal(multiline.body, "line 1\nline 2", "bodies keep their lines");
  assert.equal(sanitizeGuestNotification({ id: "abc-1", title: "‮liaMG‬: sign in" }).title, "liaMG: sign in", "bidi overrides are dropped");
  for (const bad of [null, "x", [], { title: "no id" }, { id: "has space" }, { id: "x".repeat(101) }]) {
    assert.equal(sanitizeGuestNotification(bad), null);
  }
});

test("toasts need the global switch and the service's desktop alerts", () => {
  const service = { isEnabled: true, notificationSettings: { desktopEnabled: true, captureWebNotifications: false } };
  assert.equal(shouldShowDesktopToast({ ui: { notificationsEnabled: true }, service }), true, "the retired capture toggle is ignored");
  assert.equal(shouldShowDesktopToast({ ui: { notificationsEnabled: false }, service }), false);
  assert.equal(shouldShowDesktopToast({ ui: { notificationsEnabled: true }, service: { ...service, notificationSettings: { desktopEnabled: false } } }), false);
  assert.equal(shouldShowDesktopToast({ ui: { notificationsEnabled: true }, service: { ...service, isEnabled: false } }), false);
});

test("toast titles name the service", () => {
  assert.equal(toastTitle("Discord", "Bob"), "Discord: Bob");
  assert.equal(toastTitle("Discord", "Discord: Bob"), "Discord: Bob", "already labelled");
  assert.equal(toastTitle("Discord", "discord: Bob"), "discord: Bob", "the label check ignores case");
  assert.equal(toastTitle("Discord", "Discord"), "Discord");
  assert.equal(toastTitle("Discord", "Discord - new message"), "Discord: Discord - new message", "only `Name:` counts as the label");
  // A short name must not hide the label from titles that merely start with the same letters.
  assert.equal(toastTitle("X", "Xbox alert"), "X: Xbox alert");
  assert.equal(toastTitle("S", "Slack security notice"), "S: Slack security notice");
  assert.equal(toastTitle("Comms", "Comms Hub update"), "Comms: Comms Hub update");
  // Titles are one line, so nothing can be pushed away from the label.
  assert.equal(toastTitle("Discord", "Bob\nline2\r\n\tline3"), "Discord: Bob line2 line3");
  assert.equal(toastTitle("Disc\nord", "Bob"), "Disc ord: Bob");
  assert.equal(toastTitle("Discord", "Bob\u2028Windows Security"), "Discord: Bob Windows Security");
  assert.equal(toastTitle("Discord", ""), "Discord");
  assert.equal(toastTitle("", "Windows Security"), "Comms Hub: Windows Security");
  assert.equal(overflowBody(1), "1 more notification");
  assert.equal(overflowBody(3), "3 more notifications");
});

test("one toast per notification, labelled; a click routes back with its target", () => {
  const h = harness();
  const target = { id: "n-1" };
  assert.equal(h.notifier.notify(note({ target, pageKey: "1:2:n-1", silent: true })), "shown");
  assert.equal(h.toasts.length, 1);
  assert.deepEqual(h.toasts[0].options, { title: "Discord: Bob", body: "hey", silent: true });
  assert.equal(h.toasts[0].shown, 1);
  assert.equal(h.notifier.trackedCount(), 1, "kept referenced until clicked");
  h.toasts[0].emit("click");
  assert.deepEqual(h.clicks, [{ serviceId: "discord", target }]);
  assert.equal(h.notifier.trackedCount(), 0);
});

test("a timed-out toast stays clickable from the Action Center; a dismissed one tells the page", () => {
  const h = harness();
  h.notifier.notify(note({ target: { id: "a" } }));
  h.notifier.notify(note({ target: { id: "b" } }));
  h.toasts[0].emit("close", { reason: "timedOut" });
  assert.equal(h.notifier.trackedCount(), 2);
  h.toasts[0].emit("click");
  assert.equal(h.clicks.length, 1);
  h.toasts[1].emit("close", { reason: "userCanceled" });
  assert.deepEqual(h.closes, [{ id: "b" }]);
  h.toasts[1].emit("click");
  assert.equal(h.clicks.length, 2, "a late click still routes");
});

test("a newer notification with the same tag replaces the toast; the page can close its own", () => {
  const h = harness();
  h.notifier.notify(note({ tag: "chat-1", pageKey: "k1" }));
  h.notifier.notify(note({ tag: "chat-1", pageKey: "k2" }));
  h.notifier.notify(note({ serviceId: "gmail", serviceName: "Gmail", tag: "chat-1", pageKey: "k3" }));
  assert.equal(h.toasts[0].closed, 1);
  assert.equal(h.toasts[2].closed, 0, "tags are per service");
  h.notifier.closeFromPage("k2");
  assert.equal(h.toasts[1].closed, 1);
  assert.equal(h.notifier.trackedCount(), 1);
});

test("bursts are rate-limited per service and summarized in one toast", () => {
  const h = harness({ limit: { count: 2, windowMs: 1000 } });
  assert.equal(h.notifier.notify(note()), "shown");
  assert.equal(h.notifier.notify(note()), "shown");
  assert.equal(h.notifier.notify(note()), "throttled");
  assert.equal(h.notifier.notify(note()), "throttled");
  assert.equal(h.notifier.notify(note({ serviceId: "gmail", serviceName: "Gmail" })), "shown", "other services are unaffected");
  assert.equal(h.toasts.length, 3);
  h.tick(1000);
  assert.equal(h.toasts.length, 4);
  assert.deepEqual(h.toasts[3].options, { title: "Discord", body: "2 more notifications", silent: true });
  h.toasts[3].emit("click");
  assert.deepEqual(h.clicks.at(-1), { serviceId: "discord", target: null });
});

test("unsupported, failing and forgotten toasts", () => {
  const unsupported = harness({ isSupported: () => false });
  assert.equal(unsupported.notifier.notify(note()), "unsupported");
  assert.equal(unsupported.toasts.length, 0);

  const failing = harness({ createToast: () => { throw new Error("no shell"); } });
  assert.equal(failing.notifier.notify(note()), "failed");
  assert.equal(failing.logs.length, 1);

  const h = harness({ limit: { count: 1, windowMs: 1000 } });
  h.notifier.notify(note());
  h.notifier.notify(note());
  h.toasts[0].emit("failed", {}, "boom");
  assert.equal(h.notifier.trackedCount(), 0);
  h.notifier.notify(note({ serviceId: "gmail" }));
  h.notifier.forgetService("discord");
  h.notifier.forgetService("gmail");
  assert.equal(h.timers.size, 0, "a removed service's pending summary is dropped");
  assert.equal(h.notifier.trackedCount(), 0);
  h.notifier.dispose();
});
