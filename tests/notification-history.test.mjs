import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationHistory } from "../electron/notificationHistory.js";

const history = (limit) => {
  let id = 0;
  return createNotificationHistory({ limit, now: () => 0, createId: () => `n${++id}` });
};

test("records newest first and bounds the ring buffer", () => {
  const log = history(3);
  for (let index = 1; index <= 5; index += 1) log.record({ serviceId: "a", title: `t${index}` });
  assert.deepEqual(log.list().map((entry) => entry.title), ["t5", "t4", "t3"]);
  assert.deepEqual(log.unseenCounts(), { a: 5 }, "unseen counts are not bounded by the ring");
});

test("a busy service does not evict another service's unseen count", () => {
  const log = history(5);
  for (let index = 0; index < 3; index += 1) log.record({ serviceId: "slack" });
  for (let index = 0; index < 6; index += 1) log.record({ serviceId: "discord" });
  assert.ok(log.list().every((entry) => entry.serviceId === "discord"));
  assert.deepEqual(log.unseenCounts(), { slack: 3, discord: 6 });
  assert.equal(log.markSeen("discord"), true);
  assert.deepEqual(log.unseenCounts(), { slack: 3 });
  assert.equal(log.hasUnseen("slack"), true);
});

test("defaults to 80 entries and trims long text", () => {
  const log = history();
  for (let index = 0; index < 100; index += 1) log.record({ serviceId: "a", title: "x".repeat(5000), body: "y".repeat(5000) });
  assert.equal(log.list().length, 80);
  assert.equal(log.list()[0].title.length, 300);
  assert.equal(log.list()[0].body.length, 1000);
  assert.ok(Object.isFrozen(log.list()[0]));
});

test("unseen counts are per service and markSeen only reports real changes", () => {
  const log = history();
  assert.equal(log.markSeen("a"), false);
  log.record({ serviceId: "a" });
  log.record({ serviceId: "a" });
  log.record({ serviceId: "b" });
  assert.deepEqual(log.unseenCounts(), { a: 2, b: 1 });
  assert.equal(log.markSeen("a"), true);
  assert.equal(log.markSeen("a"), false, "a second focus is a no-op");
  assert.deepEqual(log.unseenCounts(), { b: 1 });
  log.record({ serviceId: "a" });
  assert.deepEqual(log.unseenCounts(), { a: 1, b: 1 });
  assert.equal(log.markSeen(null), false);
});

test("clear and forgetService", () => {
  const log = history();
  log.record({ serviceId: "a" });
  log.record({ serviceId: "b" });
  assert.equal(log.forgetService("a"), true);
  assert.equal(log.forgetService("a"), false);
  assert.deepEqual(log.unseenCounts(), { b: 1 });
  assert.equal(log.clear(), true);
  assert.equal(log.clear(), false);
  assert.deepEqual(log.unseenCounts(), {});
});
