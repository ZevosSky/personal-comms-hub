import assert from "node:assert/strict";
import test from "node:test";
import {
  SCREEN_SHARE_TIMEOUT_MS,
  createScreenShareBroker,
  nativePickerModel,
  resolveScreenShareChoice,
  supportsLoopbackAudio,
  toPickerSource
} from "../electron/screenShare.js";

const fakeImage = ({ empty = false, width = 320 } = {}) => ({
  isEmpty: () => empty,
  getSize: () => ({ width, height: width }),
  toJPEG: (quality) => Buffer.from(`jpeg-${quality}`),
  toDataURL: () => `data:image/png;base64,icon-${width}`,
  resize: ({ width: next }) => fakeImage({ width: next })
});
const screen = { id: "screen:0:0", name: "Entire screen", thumbnail: fakeImage(), appIcon: null };
const screen2 = { id: "screen:1:0", name: "Screen 2", thumbnail: fakeImage(), appIcon: null };
const notes = { id: "window:42:0", name: "Notes", thumbnail: fakeImage({ empty: true }), appIcon: fakeImage({ width: 256 }) };

test("choices map to the display-media callback; cancel and unknown ids share nothing", () => {
  const sources = [screen, notes];
  assert.equal(resolveScreenShareChoice({ sources, sourceId: null, platform: "win32" }), null, "null denies (Electron throws on {})");
  assert.equal(resolveScreenShareChoice({ sources, sourceId: "window:999:0", platform: "win32" }), null);
  assert.deepEqual(resolveScreenShareChoice({ sources, sourceId: "window:42:0", shareAudio: true, audioRequested: true, platform: "win32" }),
    { video: notes, audio: "loopback" });
  assert.deepEqual(resolveScreenShareChoice({ sources, sourceId: "screen:0:0", shareAudio: false, audioRequested: true, platform: "win32" }),
    { video: screen }, "audio unticked: no audio key");
  assert.deepEqual(resolveScreenShareChoice({ sources, sourceId: "screen:0:0", shareAudio: true, audioRequested: false, platform: "win32" }),
    { video: screen }, "audio the page never asked for is never added");
  assert.deepEqual(resolveScreenShareChoice({ sources, sourceId: "screen:0:0", shareAudio: true, audioRequested: true, platform: "darwin" }),
    { video: screen }, "loopback audio is Windows-only");
  assert.equal(supportsLoopbackAudio("linux"), false);
});

test("picker sources carry kind, JPEG thumbnails and small app icons", () => {
  assert.deepEqual(toPickerSource(screen), {
    id: "screen:0:0",
    name: "Entire screen",
    kind: "screen",
    thumbnailDataUrl: `data:image/jpeg;base64,${Buffer.from("jpeg-70").toString("base64")}`,
    appIconDataUrl: null
  });
  const window = toPickerSource(notes);
  assert.equal(window.kind, "window");
  assert.equal(window.thumbnailDataUrl, null, "no thumbnail for an empty image");
  assert.equal(window.appIconDataUrl, "data:image/png;base64,icon-32", "app icons are shrunk to 32 px");
  assert.equal(toPickerSource({ id: "window:1:0", name: "x".repeat(500) }).name.length, 200);
});

test("the native fallback lists screens, then windows, then Cancel", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `window:${index}:0`, name: `Window ${index}` }));
  const { choices, options } = nativePickerModel({ serviceName: "Teams", sources: [screen, screen2, ...many], audioRequested: true });
  assert.equal(choices.length, 2 + 12, "windows are capped");
  assert.equal(options.buttons[0], "Screen: Entire screen");
  assert.equal(options.buttons[2], "Window: Window 0");
  assert.equal(options.buttons.at(-1), "Cancel");
  assert.equal(options.cancelId, options.buttons.length - 1);
  assert.equal(options.defaultId, options.cancelId, "nothing is pre-selected");
  assert.equal(options.checkboxLabel, "Also share system audio");
  assert.equal(options.checkboxChecked, false);
  assert.match(options.message, /Teams wants to share your screen/);
  assert.equal(options.detail, "Choose a screen or window to share.");
  const foreign = nativePickerModel({ serviceName: "Teams", sources: [screen], audioRequested: false, foreignOrigin: "https://ads.example" });
  assert.equal(foreign.options.detail,
    "Requested by https://ads.example, which is not part of Teams's own site.\nChoose a screen or window to share.");
  const single = nativePickerModel({ serviceName: "Teams", sources: [screen], audioRequested: false });
  assert.deepEqual(single.options.buttons, ["Entire screen", "Cancel"]);
  assert.equal("checkboxLabel" in single.options, false, "no audio checkbox when audio was not requested");
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ownOrigin = "https://teams.microsoft.com";

function createHarness({ hasPicker = true, platform = "win32", sources = [screen, notes], nativeAnswer, host: hostOverride } = {}) {
  const timers = new Map();
  let timerId = 0;
  let clock = 1000;
  const sent = [];
  const picked = [];
  const watchers = new Map();
  const native = [];
  let changes = 0;
  const host = hostOverride === undefined
    ? { id: 100, hasPicker, window: {}, send: (channel, payload) => sent.push({ channel, payload }) }
    : hostOverride;
  const broker = createScreenShareBroker({
    describeGuest: (guestId) => (guestId === 404 ? null : { serviceId: `service-${guestId}`, serviceName: "Teams" }),
    getSources: async () => {
      if (sources instanceof Error) throw sources;
      return sources;
    },
    prepareHost: async () => host,
    showNativePicker: ({ options, signal }) => {
      native.push({ options, signal });
      return nativeAnswer ? Promise.resolve(nativeAnswer) : new Promise((resolve) => signal.addEventListener("abort", () => resolve({ response: options.cancelId })));
    },
    watchGuest: (guestId, onGone) => {
      watchers.set(guestId, onGone);
      return () => watchers.delete(guestId);
    },
    onPicked: (guestId) => picked.push(guestId),
    onChange: () => { changes += 1; },
    platform,
    now: () => clock,
    setTimeoutFn: (fn, delay) => { timerId += 1; timers.set(timerId, { fn, delay }); return timerId; },
    clearTimeoutFn: (id) => timers.delete(id)
  });
  // The permission step: shows the picker; resolves true once a source is picked.
  const start = (guestId = 1, { origin = ownOrigin, foreignOrigin = null } = {}) => {
    const result = { answer: undefined };
    result.done = broker.approve({ guestId, origin, foreignOrigin }).then((answer) => {
      result.answer = answer;
      return answer;
    });
    return result;
  };
  // The display-media step that follows a granted permission.
  const share = (guestId = 1, { origin = ownOrigin, videoRequested = true, audioRequested = false } = {}) => {
    const calls = [];
    broker.handleRequest({ guestId, origin, videoRequested, audioRequested }, (streams) => calls.push(streams));
    assert.equal(calls.length, 1, "the display-media callback runs exactly once");
    return calls[0];
  };
  const requests = () => sent.filter(({ channel }) => channel === "screen-share:request").map(({ payload }) => payload);
  return {
    broker,
    start,
    share,
    requests,
    sent,
    picked,
    watchers,
    native,
    timers,
    host,
    changes: () => changes,
    advance: (ms) => { clock += ms; }
  };
}

test("an in-app picker gets the request and hides the service; the pick is shared once", async () => {
  const harness = createHarness();
  const request = harness.start(1);
  await flush();
  assert.equal(harness.sent.length, 1);
  const { channel, payload } = harness.sent[0];
  assert.equal(channel, "screen-share:request");
  assert.equal(payload.serviceId, "service-1");
  assert.equal(payload.serviceName, "Teams");
  assert.equal(payload.foreignOrigin, null, "the service's own site is not called out");
  assert.equal(payload.audioRequested, true, "system audio is offered where loopback works");
  assert.deepEqual(payload.sources.map((source) => [source.id, source.kind]), [["screen:0:0", "screen"], ["window:42:0", "window"]]);
  assert.equal(harness.broker.isPickerOpen(100), true, "the host keeps the native page hidden");
  assert.equal(harness.picked.length, 0, "nothing is protected before a pick");
  assert.equal(harness.share(1), null, "nothing is shared while the picker is open");

  assert.equal(harness.broker.respond(999, { requestId: payload.requestId, sourceId: "screen:0:0" }), false, "only the host may answer");
  assert.equal(harness.broker.respond(100, { requestId: "share-unknown", sourceId: "screen:0:0" }), false);
  await flush();
  assert.equal(request.answer, undefined);

  assert.equal(harness.broker.respond(100, { requestId: payload.requestId, sourceId: "window:42:0", shareAudio: true }), true);
  assert.equal(await request.done, true, "the permission is granted only now");
  assert.deepEqual(harness.picked, [1]);
  assert.equal(harness.broker.isPickerOpen(100), false);
  assert.equal(harness.timers.size, 0, "the timeout is cleared");
  assert.equal(harness.watchers.size, 0, "the guest is no longer watched");
  assert.equal(harness.broker.respond(100, { requestId: payload.requestId, sourceId: "screen:0:0" }), false, "answered once");
  assert.equal(harness.sent.length, 1, "no cancel message after an answer");

  assert.deepEqual(harness.share(1, { audioRequested: true }), { video: notes, audio: "loopback" });
  assert.equal(harness.share(1, { audioRequested: true }), null, "a pick is used once");
});

test("display-media requests without a fresh pick for that page and origin are denied", async () => {
  const harness = createHarness();
  assert.equal(harness.share(1), null, "no picker, no capture");

  const pick = async (guestId = 1, options = {}) => {
    harness.advance(60001); // past the per-page rate limit
    const request = harness.start(guestId, options);
    await flush();
    const { requestId } = harness.requests().at(-1);
    harness.broker.respond(100, { requestId, sourceId: "screen:0:0", shareAudio: true });
    assert.equal(await request.done, true);
  };
  await pick();
  assert.equal(harness.share(2), null, "another page cannot use it");
  assert.deepEqual(harness.share(1), { video: screen }, "the page it was picked for still can");
  await pick();
  assert.equal(harness.share(1, { origin: "https://ads.example" }), null, "another origin in the page cannot use it");
  await pick();
  harness.advance(5001);
  assert.equal(harness.share(1), null, "a pick expires after a few seconds");
  await pick();
  assert.equal(harness.share(1, { videoRequested: false }), null);
  await pick();
  assert.deepEqual(harness.share(1, { audioRequested: false }), { video: screen }, "audio the page never asked for is never added");

  // A new request discards an unused pick.
  await pick();
  const again = harness.start(1);
  await flush();
  assert.equal(harness.share(1), null);
  harness.broker.respond(100, { requestId: harness.requests().at(-1).requestId, sourceId: null });
  assert.equal(await again.done, false);
});

test("cancel from the picker grants nothing and protects nothing", async () => {
  const harness = createHarness({ platform: "darwin" });
  const request = harness.start(1);
  await flush();
  assert.equal(harness.sent[0].payload.audioRequested, false, "no system audio without loopback");
  harness.broker.respond(100, { requestId: harness.sent[0].payload.requestId, sourceId: null, shareAudio: true });
  assert.equal(await request.done, false);
  assert.deepEqual(harness.picked, []);
  assert.equal(harness.share(1), null);
});

test("a page outside the service's own site is named in the picker", async () => {
  const harness = createHarness();
  const request = harness.start(1, { origin: "https://ads.example", foreignOrigin: "https://ads.example" });
  await flush();
  assert.equal(harness.sent[0].payload.foreignOrigin, "https://ads.example");
  harness.broker.respond(100, { requestId: harness.sent[0].payload.requestId, sourceId: "screen:0:0" });
  assert.equal(await request.done, true);
  assert.deepEqual(harness.share(1, { origin: "https://ads.example" }), { video: screen });

  const fallback = createHarness({ hasPicker: false, nativeAnswer: { response: 0 } });
  const asked = fallback.start(1, { origin: "https://ads.example", foreignOrigin: "https://ads.example" });
  assert.equal(await asked.done, true);
  assert.equal(fallback.native[0].options.detail,
    "Requested by https://ads.example, which is not part of Teams's own site.\nChoose a screen or window to share.");
});

test("one in-app picker per window: a second page's request waits for the first, then shows", async () => {
  const harness = createHarness();
  const first = harness.start(1);
  const second = harness.start(2);
  await flush();
  assert.deepEqual(harness.requests().map((payload) => payload.serviceId), ["service-1"], "the second request is not shown yet");
  assert.equal(harness.broker.pendingCount(), 2);
  assert.equal(harness.broker.isPickerOpen(100), true);
  assert.equal(harness.broker.respond(100, { requestId: "share-2", sourceId: "screen:0:0" }), false, "a waiting request cannot be answered");

  harness.broker.respond(100, { requestId: "share-1", sourceId: null });
  assert.equal(await first.done, false);
  assert.deepEqual(harness.requests().map((payload) => payload.requestId), ["share-1", "share-2"], "the next request shows once the first settles");
  assert.equal(harness.broker.isPickerOpen(100), true);
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.values()][0].delay, SCREEN_SHARE_TIMEOUT_MS, "it gets the full time to answer");
  harness.broker.respond(100, { requestId: "share-2", sourceId: "screen:0:0" });
  assert.equal(await second.done, true);
  assert.equal(harness.broker.isPickerOpen(100), false, "no picker left once both settled");
  assert.equal(harness.broker.pendingCount(), 0);
  assert.deepEqual(harness.share(2), { video: screen });

  // A waiting request that ends is dropped quietly; closing the window shows nothing more.
  const shown = harness.start(3);
  const waiting = harness.start(4);
  const third = harness.start(5);
  await flush();
  const sentBefore = harness.sent.length;
  harness.watchers.get(4)();
  assert.equal(await waiting.done, false);
  assert.equal(harness.sent.length, sentBefore, "nothing to cancel in the window for a request it never showed");
  harness.broker.cancelForHost(100);
  assert.deepEqual([await shown.done, await third.done], [false, false]);
  assert.deepEqual(harness.sent.slice(sentBefore).map(({ channel }) => channel), ["screen-share:cancelled"], "only the shown request is cancelled");
  assert.equal(harness.broker.isPickerOpen(100), false);
});

test("requests time out after 120 s, end on navigation and are superseded per page", async () => {
  const harness = createHarness();
  const first = harness.start(1);
  await flush();
  const [timer] = harness.timers.values();
  assert.equal(timer.delay, SCREEN_SHARE_TIMEOUT_MS);
  timer.fn();
  assert.equal(await first.done, false);
  assert.deepEqual(harness.sent.at(-1), {
    channel: "screen-share:cancelled",
    payload: { requestId: harness.sent[0].payload.requestId, reason: "timeout" }
  });

  const second = harness.start(1);
  await flush();
  harness.watchers.get(1)();
  assert.equal(await second.done, false);
  assert.equal(harness.sent.at(-1).payload.reason, "navigated");

  const third = harness.start(1);
  await flush();
  const fourth = harness.start(1);
  assert.equal(await third.done, false, "one pending request per page: the newer one wins");
  assert.equal(harness.sent.at(-1).payload.reason, "superseded");
  await flush();
  assert.equal(harness.broker.pendingCount(), 1);
  harness.broker.respond(100, { requestId: harness.requests().at(-1).requestId, sourceId: "screen:0:0" });
  assert.equal(await fourth.done, true);
  assert.deepEqual(harness.share(1), { video: screen });

  const other = harness.start(2);
  await flush();
  harness.broker.cancelForHost(100);
  assert.equal(await other.done, false, "a closed host cancels its requests");
});

test("without an in-app picker a native dialog asks; its answer or a cancel settles the request", async () => {
  const chosen = createHarness({ hasPicker: false, nativeAnswer: { response: 1, checkboxChecked: true } });
  const pick = chosen.start(1);
  assert.equal(await pick.done, true);
  assert.equal(chosen.native.length, 1);
  assert.equal(chosen.native[0].options.buttons[1], "Window: Notes");
  assert.equal(chosen.native[0].options.detail, "Choose a screen or window to share.");
  assert.deepEqual(chosen.share(1, { audioRequested: true }), { video: notes, audio: "loopback" });
  assert.deepEqual(chosen.picked, [1]);
  assert.equal(chosen.sent.length, 0, "nothing is sent to a renderer without a picker");

  const pending = createHarness({ hasPicker: false });
  const request = pending.start(1);
  await flush();
  assert.equal(pending.native.length, 1);
  pending.watchers.get(1)();
  assert.equal(await request.done, false);
  assert.equal(pending.native[0].signal.aborted, true, "the dialog is closed when the page navigates");
});

test("unknown pages, failures, rate limits and disposal never leave a request unanswered", async () => {
  const harness = createHarness();
  assert.equal(await harness.start(404).done, false);

  const failing = createHarness({ sources: new Error("capture unavailable") });
  assert.equal(await failing.start(1).done, false);

  const hostless = createHarness({ host: null });
  assert.equal(await hostless.start(1).done, false);

  const spam = createHarness();
  const results = [];
  for (let index = 0; index < 6; index += 1) results.push(spam.start(1));
  assert.equal(await results.at(-1).done, false, "a sixth request within a minute is refused");
  await flush();
  spam.broker.dispose();
  assert.deepEqual(await Promise.all(results.map(({ done }) => done)), [false, false, false, false, false, false],
    "every request was answered");
  assert.equal(spam.broker.pendingCount(), 0);
  assert.equal(spam.share(1), null, "a disposed broker shares nothing");
});
