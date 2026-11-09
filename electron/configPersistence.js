// JSON file backing for the config store. Electron-free; `fs` is injectable for tests.
import nodeFs from "node:fs";
import path from "node:path";

// Windows reports these while antivirus, indexers or sync tools hold the file briefly.
const transientErrorCodes = new Set(["EPERM", "EBUSY", "EACCES", "EAGAIN", "EMFILE", "ENFILE", "UNKNOWN"]);

const sleepSync = (milliseconds) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const backupTimestamp = (time) => new Date(time).toISOString().replace(/[:.]/g, "-");

/**
 * load() → { status: "ok" | "missing" | "corrupt" | "unreadable", data, error?, backupPath? }
 * - corrupt: unparseable or structurally invalid; the file was moved to
 *   `<name>.corrupt-<timestamp>.json` so starting from defaults never destroys it.
 * - unreadable: an I/O error survived the retries (or the backup failed). Callers must not
 *   write, or they would replace the user's settings with defaults.
 * save(data) writes atomically (temp file + fsync + rename) and throws on failure.
 */
export function createJsonFileBacking({
  filePath,
  validate = () => null,
  fs = nodeFs,
  now = Date.now,
  sleep = sleepSync,
  attempts = 5
}) {
  const directory = path.dirname(filePath);
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);

  const withRetries = (operation) => {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (!transientErrorCodes.has(error?.code)) throw error;
        lastError = error;
        if (attempt < attempts - 1) sleep(10 * 2 ** attempt);
      }
    }
    throw lastError;
  };

  const backUpCorruptFile = () => {
    const backupPath = path.join(directory, `${baseName}.corrupt-${backupTimestamp(now())}${extension}`);
    withRetries(() => fs.renameSync(filePath, backupPath));
    return backupPath;
  };

  return {
    filePath,
    load() {
      let text;
      try {
        text = withRetries(() => fs.readFileSync(filePath, "utf8"));
      } catch (error) {
        return error?.code === "ENOENT"
          ? { status: "missing", data: null }
          : { status: "unreadable", data: null, error };
      }

      let data;
      let problem = null;
      try {
        data = JSON.parse(String(text).replace(/^﻿/, ""));
        const invalid = validate(data);
        if (invalid) problem = new Error(invalid);
      } catch (error) {
        problem = error;
      }
      if (!problem) return { status: "ok", data };

      try {
        return { status: "corrupt", data: null, error: problem, backupPath: backUpCorruptFile() };
      } catch (error) {
        return { status: "unreadable", data: null, error };
      }
    },
    save(data) {
      const text = `${JSON.stringify(data, null, "\t")}\n`;
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      fs.mkdirSync(directory, { recursive: true });
      withRetries(() => {
        const descriptor = fs.openSync(temporaryPath, "w");
        try {
          fs.writeFileSync(descriptor, text, "utf8");
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      });
      try {
        withRetries(() => fs.renameSync(temporaryPath, filePath));
      } catch (error) {
        try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
        throw error;
      }
    }
  };
}
