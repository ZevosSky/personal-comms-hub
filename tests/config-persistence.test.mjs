import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateConfigShape } from "../electron/appStateModel.js";
import { createJsonFileBacking } from "../electron/configPersistence.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "comms-hub-config-test-"));
const noSleep = () => {};

function setup({ fsImpl = fs } = {}) {
  const directory = tempDir();
  const filePath = path.join(directory, "comms-app-config.json");
  const backing = createJsonFileBacking({
    filePath,
    validate: validateConfigShape,
    fs: fsImpl,
    sleep: noSleep,
    now: () => Date.parse("2026-10-30T10:20:30.456Z")
  });
  return { directory, filePath, backing, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

// Wraps node:fs so selected calls fail a number of times with an errno code.
function flakyFs(failures) {
  const remaining = { ...failures };
  return new Proxy(fs, {
    get(target, property) {
      const original = target[property];
      if (typeof original !== "function") return original;
      return (...args) => {
        const rule = remaining[property];
        if (rule && rule.count > 0) {
          rule.count -= 1;
          throw Object.assign(new Error(`${rule.code}: simulated`), { code: rule.code });
        }
        return original.apply(target, args);
      };
    }
  });
}

test("missing file loads as missing", (t) => {
  const { backing, cleanup } = setup();
  t.after(cleanup);
  assert.deepEqual(backing.load(), { status: "missing", data: null });
});

test("valid file loads, including a UTF-8 BOM", (t) => {
  const { backing, filePath, cleanup } = setup();
  t.after(cleanup);
  fs.writeFileSync(filePath, `﻿${JSON.stringify({ ui: { windowMode: "dock" } })}`);
  assert.deepEqual(backing.load(), { status: "ok", data: { ui: { windowMode: "dock" } } });
});

for (const [label, contents] of [
  ["unparseable", "{not json"],
  ["schema-invalid", JSON.stringify({ services: "gmail" })],
  ["non-object", "[]"]
]) {
  test(`${label} file is backed up, never deleted`, (t) => {
    const { backing, filePath, directory, cleanup } = setup();
    t.after(cleanup);
    fs.writeFileSync(filePath, contents);
    const result = backing.load();
    assert.equal(result.status, "corrupt");
    assert.equal(result.data, null);
    assert.equal(path.basename(result.backupPath), "comms-app-config.corrupt-2026-10-30T10-20-30-456Z.json");
    assert.equal(fs.readFileSync(result.backupPath, "utf8"), contents);
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(result.backupPath)]);
  });
}

test("transient read errors are retried", (t) => {
  const { filePath, cleanup } = setup();
  t.after(cleanup);
  fs.writeFileSync(filePath, JSON.stringify({ services: [] }));
  const backing = createJsonFileBacking({
    filePath,
    fs: flakyFs({ readFileSync: { code: "EBUSY", count: 2 } }),
    sleep: noSleep
  });
  assert.deepEqual(backing.load(), { status: "ok", data: { services: [] } });
});

test("persistent I/O errors report unreadable and leave the file alone", (t) => {
  const { filePath, cleanup } = setup();
  t.after(cleanup);
  fs.writeFileSync(filePath, JSON.stringify({ services: [{ id: "keep-me" }] }));
  const backing = createJsonFileBacking({
    filePath,
    fs: flakyFs({ readFileSync: { code: "UNKNOWN", count: 99 } }),
    sleep: noSleep
  });
  const result = backing.load();
  assert.equal(result.status, "unreadable");
  assert.equal(result.error.code, "UNKNOWN");
  assert.match(fs.readFileSync(filePath, "utf8"), /keep-me/);
});

test("a corrupt file that cannot be backed up is reported unreadable", (t) => {
  const { filePath, cleanup } = setup();
  t.after(cleanup);
  fs.writeFileSync(filePath, "{bad");
  const backing = createJsonFileBacking({
    filePath,
    validate: validateConfigShape,
    fs: flakyFs({ renameSync: { code: "EPERM", count: 99 } }),
    sleep: noSleep
  });
  assert.equal(backing.load().status, "unreadable");
  assert.equal(fs.readFileSync(filePath, "utf8"), "{bad");
});

test("save writes atomically, creates the directory and retries a locked rename", (t) => {
  const { directory, cleanup } = setup();
  t.after(cleanup);
  const filePath = path.join(directory, "nested", "comms-app-config.json");
  const backing = createJsonFileBacking({
    filePath,
    fs: flakyFs({ renameSync: { code: "EPERM", count: 2 } }),
    sleep: noSleep
  });
  backing.save({ ui: { windowMode: "dock" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { ui: { windowMode: "dock" } });
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ["comms-app-config.json"], "no temp file left behind");
  backing.save({ ui: { windowMode: "full" } });
  assert.deepEqual(backing.load(), { status: "ok", data: { ui: { windowMode: "full" } } });
});

test("a save that keeps failing throws and cleans up its temp file", (t) => {
  const { filePath, cleanup } = setup();
  t.after(cleanup);
  fs.writeFileSync(filePath, JSON.stringify({ ui: { windowMode: "full" } }));
  const backing = createJsonFileBacking({
    filePath,
    fs: flakyFs({ renameSync: { code: "EBUSY", count: 99 } }),
    sleep: noSleep
  });
  assert.throws(() => backing.save({ ui: { windowMode: "dock" } }), /EBUSY/);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ["comms-app-config.json"]);
  assert.match(fs.readFileSync(filePath, "utf8"), /"full"/);
});
