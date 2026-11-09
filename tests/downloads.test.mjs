import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { createDownloadManager, safeDownloadName, uniqueDownloadPath } from "../electron/downloads.js";

test("download names are plain, safe file names", () => {
  assert.equal(safeDownloadName("report.pdf"), "report.pdf");
  assert.equal(safeDownloadName("..\\..\\evil.exe"), "evil.exe");
  assert.equal(safeDownloadName("../../etc/passwd"), "passwd");
  assert.equal(safeDownloadName('a:b?"c*.txt'), "a_b__c_.txt");
  assert.equal(safeDownloadName("name. . "), "name");
  assert.equal(safeDownloadName(""), "download");
  assert.equal(safeDownloadName(".."), "download");
  assert.equal(safeDownloadName(undefined), "download");
  assert.equal(safeDownloadName("CON"), "_CON");
  assert.equal(safeDownloadName("nul.txt"), "_nul.txt");
  const long = safeDownloadName(`${"x".repeat(300)}.zip`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith(".zip"));
});

test("unique names count up before the extension, like a browser", () => {
  const dir = "C:\\Users\\me\\Downloads";
  const taken = new Set([path.win32.join(dir, "report.txt"), path.win32.join(dir, "report (1).txt")]);
  const isTaken = (candidate) => taken.has(candidate);
  assert.equal(uniqueDownloadPath(dir, "fresh.txt", isTaken, path.win32), path.win32.join(dir, "fresh.txt"));
  assert.equal(uniqueDownloadPath(dir, "report.txt", isTaken, path.win32), path.win32.join(dir, "report (2).txt"));
  taken.add(path.win32.join(dir, "archive.tar.gz"));
  assert.equal(uniqueDownloadPath(dir, "archive.tar.gz", isTaken, path.win32), path.win32.join(dir, "archive (1).tar.gz"));
  taken.add(path.win32.join(dir, "README"));
  assert.equal(uniqueDownloadPath(dir, "README", isTaken, path.win32), path.win32.join(dir, "README (1)"));
});

const fakeItem = ({ filename = "file.txt", total = 100 } = {}) => {
  const item = new EventEmitter();
  item.filename = filename;
  item.total = total;
  item.received = 0;
  item.savePath = "";
  item.dialogOptions = null;
  item.getFilename = () => item.filename;
  item.getTotalBytes = () => item.total;
  item.getReceivedBytes = () => item.received;
  item.setSavePath = (value) => { item.savePath = value; };
  item.getSavePath = () => item.savePath;
  item.setSaveDialogOptions = (options) => { item.dialogOptions = options; };
  item.state = "progressing";
  item.resumable = false;
  item.cancelled = 0;
  item.getState = () => item.state;
  item.canResume = () => item.resumable;
  item.cancel = () => { item.cancelled += 1; item.finish("cancelled"); };
  item.progress = (received) => { item.received = received; item.emit("updated", {}, "progressing"); };
  item.interrupt = ({ resumable = false } = {}) => {
    item.state = "interrupted";
    item.resumable = resumable;
    item.emit("updated", {}, "interrupted");
  };
  item.finish = (state) => { item.state = state; item.emit("done", {}, state); };
  return item;
};

const fakeTimers = () => {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: (callback, delay) => { const id = next++; pending.set(id, { callback, delay }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    runAll: () => { for (const [id, { callback }] of [...pending]) { pending.delete(id); callback(); } }
  };
};

const createManager = (overrides = {}) => {
  const events = { progress: [], completed: [], failed: [], prepared: [], logs: [] };
  const manager = createDownloadManager({
    getDirectory: () => "/downloads",
    isTaken: (candidate) => candidate === "/downloads/taken.txt",
    prepareDirectory: (directory) => events.prepared.push(directory),
    setProgress: (value) => events.progress.push(value),
    onCompleted: (details) => events.completed.push(details),
    onFailed: (details) => events.failed.push(details),
    log: (message) => events.logs.push(message),
    pathApi: path.posix,
    ...overrides
  });
  return { manager, events };
};

test("downloads save straight to the folder, never twice to the same name, and report combined progress", () => {
  const { manager, events } = createManager();
  const first = fakeItem({ filename: "taken.txt", total: 100 });
  const second = fakeItem({ filename: "taken.txt", total: 300 });
  assert.equal(manager.handle(first), "/downloads/taken (1).txt");
  assert.equal(manager.handle(second), "/downloads/taken (2).txt", "an in-flight download keeps its name reserved");
  assert.deepEqual(events.prepared, ["/downloads", "/downloads"]);
  first.progress(50);
  second.progress(150);
  assert.equal(events.progress.at(-1), 0.5);
  first.finish("completed");
  assert.deepEqual(events.completed, [{ fileName: "taken (1).txt", savePath: "/downloads/taken (1).txt" }]);
  assert.equal(events.progress.at(-1), 0.5, "only the remaining download counts");
  second.finish("interrupted");
  assert.deepEqual(events.failed, [{ fileName: "taken (2).txt" }]);
  assert.equal(events.progress.at(-1), null, "progress cleared when nothing is left");
  assert.equal(manager.activeCount(), 0);
  // Reserved names are released when a download ends.
  assert.equal(manager.handle(fakeItem({ filename: "taken.txt" })), "/downloads/taken (1).txt");
});

test("unknown sizes show indeterminate progress; cancelled downloads say nothing", () => {
  const { manager, events } = createManager();
  const item = fakeItem({ total: 0 });
  manager.handle(item);
  assert.equal(events.progress.at(-1), "indeterminate");
  item.finish("cancelled");
  assert.deepEqual(events.completed, []);
  assert.deepEqual(events.failed, []);
  assert.equal(events.progress.at(-1), null);
});

test("asking where to save leaves the Save As dialog to Chromium, starting in Downloads", () => {
  const { manager, events } = createManager({ askWhereToSave: () => true });
  const item = fakeItem({ filename: "photo.png" });
  assert.equal(manager.handle(item), null);
  assert.equal(item.savePath, "");
  assert.deepEqual(item.dialogOptions, { defaultPath: "/downloads/photo.png" });
  item.savePath = "/elsewhere/holiday.png";
  item.finish("completed");
  assert.deepEqual(events.completed, [{ fileName: "holiday.png", savePath: "/elsewhere/holiday.png" }]);
});

test("a folder that cannot be created or found falls back safely", () => {
  const { manager, events } = createManager({ prepareDirectory: () => { throw new Error("EACCES"); } });
  assert.equal(manager.handle(fakeItem({ filename: "a.txt" })), "/downloads/a.txt");
  assert.match(events.logs[0], /Downloads folder/);
  const missing = createManager({ getDirectory: () => { throw new Error("no folder"); } });
  const item = fakeItem();
  assert.equal(missing.manager.handle(item), null, "the Save As dialog is used instead");
  assert.equal(item.dialogOptions, null);
});

test("a network drop that leaves a download interrupted reports one failure and clears progress", () => {
  const timers = fakeTimers();
  const { manager, events } = createManager({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  // Cannot resume: failed at once, then cancelled so the partial file goes away.
  const dead = fakeItem({ filename: "dead.zip" });
  manager.handle(dead);
  dead.progress(40);
  dead.interrupt({ resumable: false });
  assert.deepEqual(events.failed, [{ fileName: "dead.zip" }]);
  assert.equal(events.progress.at(-1), null, "the taskbar progress is cleared");
  assert.equal(dead.cancelled, 0, "cancelled later, outside Chromium's update callback");
  timers.runAll();
  assert.equal(dead.cancelled, 1);
  dead.finish("interrupted");
  assert.equal(events.failed.length, 1, "a later 'done' does not report it again");
  assert.equal(manager.activeCount(), 0);
  assert.equal(timers.pending.size, 0);

  // Resumable but nothing resumes it: failed once the grace period runs out.
  const stuck = fakeItem({ filename: "stuck.zip" });
  manager.handle(stuck);
  stuck.progress(40);
  stuck.interrupt({ resumable: true });
  stuck.interrupt({ resumable: true });
  assert.equal(events.failed.length, 1, "no failure while it may still resume");
  assert.equal(timers.pending.size, 1, "one grace timer, however many updates arrive");
  assert.equal([...timers.pending.values()][0].delay, 10000);
  timers.runAll();
  assert.deepEqual(events.failed.at(-1), { fileName: "stuck.zip" });
  assert.equal(events.failed.length, 2);
  timers.runAll();
  assert.equal(stuck.cancelled, 1);
  assert.equal(events.progress.at(-1), null);
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.handle(fakeItem({ filename: "stuck.zip" })), "/downloads/stuck.zip", "its name is released");

  // Only a still-interrupted item is cancelled.
  const ended = fakeItem({ filename: "ended.zip" });
  manager.handle(ended);
  ended.interrupt({ resumable: false });
  ended.state = "cancelled";
  timers.runAll();
  assert.equal(ended.cancelled, 0);
  assert.equal(events.failed.length, 3);
});

test("a download that resumes after an interruption completes normally", () => {
  const timers = fakeTimers();
  const { manager, events } = createManager({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const item = fakeItem({ filename: "back.zip", total: 100 });
  manager.handle(item);
  item.interrupt({ resumable: true });
  assert.equal(timers.pending.size, 1);
  item.state = "progressing";
  item.progress(60);
  assert.equal(timers.pending.size, 0, "progress cancels the grace timer");
  assert.equal(events.progress.at(-1), 0.6);
  item.finish("completed");
  assert.deepEqual(events.failed, []);
  assert.deepEqual(events.completed, [{ fileName: "back.zip", savePath: "/downloads/back.zip" }]);
  assert.equal(item.cancelled, 0);
  // A grace timer that fires after the item came back does nothing.
  const late = fakeItem({ filename: "late.zip" });
  manager.handle(late);
  late.interrupt({ resumable: true });
  late.state = "progressing";
  timers.runAll();
  assert.deepEqual(events.failed, []);
  assert.equal(manager.activeCount(), 1);
});
