import assert from "node:assert/strict";
import test from "node:test";
import { createFrameStateQuery, frameKeyOf, frameTargetsFor, normalizeFrameState } from "../electron/guestFrames.js";

function fakeTimers() {
  const timers = new Map();
  let sequence = 0;
  return {
    timers,
    setTimeoutFn: (fn) => { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimeoutFn: (id) => timers.delete(id),
    fireAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }
  };
}

test("frame keys are the stable frame tree node id", () => {
  assert.equal(frameKeyOf({ frameTreeNodeId: 12, isDestroyed: () => false }), 12);
  assert.equal(frameKeyOf({ frameTreeNodeId: 12, isDestroyed: () => true }), null);
  assert.equal(frameKeyOf(null), null);
  assert.equal(frameKeyOf({ get frameTreeNodeId() { throw new Error("gone"); } }), null);
  assert.deepEqual(normalizeFrameState({ dirty: "yes", captures: 2.7 }), { dirty: false, captures: 2 });
  assert.deepEqual(normalizeFrameState({ dirty: true, captures: -1 }), { dirty: true, captures: 0 });
});

test("a query resolves once every asked frame answered; gone frames resolve as null", async () => {
  const clock = fakeTimers();
  const query = createFrameStateQuery(clock);
  const sent = [];
  const pending = query.query([
    { key: 1, send: (channel, requestId) => sent.push({ key: 1, channel, requestId }) },
    { key: 2, send: (channel, requestId) => sent.push({ key: 2, channel, requestId }) },
    { key: 3, send: null }
  ]);
  assert.deepEqual(sent.map((message) => [message.key, message.channel]), [[1, "guest:query-state"], [2, "guest:query-state"]]);
  const { requestId } = sent[0];
  assert.equal(query.receive(9, { requestId, dirty: true }), false, "a frame that was not asked is ignored");
  assert.equal(query.receive(1, { requestId: "other", dirty: true }), false);
  assert.equal(query.receive(1, { requestId, dirty: true, captures: 0 }), true);
  assert.equal(query.receive(1, { requestId, dirty: false }), false, "one answer per frame");
  query.receive(2, { requestId, dirty: false, captures: 1 });
  const replies = await pending;
  assert.deepEqual([...replies], [[3, null], [1, { dirty: true, captures: 0 }], [2, { dirty: false, captures: 1 }]]);
  assert.equal(clock.timers.size, 0);
});

test("frames that do not answer in time are left out", async () => {
  const clock = fakeTimers();
  const query = createFrameStateQuery(clock);
  let requestId;
  const pending = query.query([
    { key: 1, send: (_channel, id) => { requestId = id; } },
    { key: 2, send: () => { throw new Error("frame gone"); } }
  ]);
  clock.fireAll();
  const replies = await pending;
  assert.deepEqual([...replies], [[2, null]]);
  assert.equal(query.receive(1, { requestId, dirty: true }), false, "late answers are dropped");
  assert.deepEqual([...(await query.query([]))], []);
});

test("query targets come from the page's frame tree", () => {
  const sent = [];
  const frame = (key, detached = false) => ({ frameTreeNodeId: key, detached, isDestroyed: () => false, send: (...args) => sent.push([key, ...args]) });
  const contents = { isDestroyed: () => false, mainFrame: { framesInSubtree: [frame(1), frame(2, true), frame(3)] } };
  const targets = frameTargetsFor(contents, [3, 2, 7]);
  assert.deepEqual(targets.map((target) => [target.key, typeof target.send]), [[3, "function"], [2, "object"], [7, "object"]]);
  targets[0].send("guest:query-state", "q1");
  assert.deepEqual(sent, [[3, "guest:query-state", "q1"]]);
  assert.deepEqual(frameTargetsFor({ isDestroyed: () => true }, [1]).map((target) => target.send), [null]);
});
