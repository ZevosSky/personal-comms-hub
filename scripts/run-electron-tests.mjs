import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.resolve(root, process.argv[2] || path.join("tests", "fixtures", "electron-lifecycle.mjs"));
const fixtureRelative = path.relative(root, fixture);
if (path.isAbsolute(fixtureRelative) || fixtureRelative.startsWith(`..${path.sep}`) || fixtureRelative === "..") {
  throw new Error(`Electron test fixture must be inside the repository: ${fixture}`);
}
const electronExecutable = require("electron");
const temporaryRoot = path.resolve(os.tmpdir());
const runRoot = path.resolve(await mkdtemp(path.join(temporaryRoot, "comms-hub-electron-")));
const userData = path.join(runRoot, "user-data");
const output = path.join(runRoot, "output");

const assertSafeRunRoot = () => {
  const relative = path.relative(temporaryRoot, runRoot);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    !path.basename(runRoot).startsWith("comms-hub-electron-")
  ) {
    throw new Error(`Refusing to clean unexpected Electron test path: ${runRoot}`);
  }
};

await Promise.all([
  mkdir(userData, { recursive: true }),
  mkdir(output, { recursive: true })
]);

const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = process.env;
const child = spawn(electronExecutable, [fixture], {
  cwd: root,
  env: {
    ...environment,
    COMMS_ELECTRON_USER_DATA: userData,
    COMMS_ELECTRON_TEST_OUTPUT: output
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
let timedOut = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const timeout = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 90000);
timeout.unref?.();

let childExitCode = null;
let childSignal = null;
let spawnError = null;
try {
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  childExitCode = outcome.code ?? null;
  childSignal = outcome.signal ?? null;
  spawnError = outcome.error ?? null;
} finally {
  clearTimeout(timeout);
}

const reportPrefix = "COMMS_ELECTRON_TEST_REPORT ";
const reportLine = stdout
  .split(/\r?\n/)
  .reverse()
  .find((line) => line.startsWith(reportPrefix));
let fixtureReport = null;
let reportParseError = null;
if (reportLine) {
  try {
    fixtureReport = JSON.parse(reportLine.slice(reportPrefix.length));
  } catch (error) {
    reportParseError = error instanceof Error ? error.message : String(error);
  }
}

let cleanupError = null;
try {
  assertSafeRunRoot();
  await rm(runRoot, { recursive: true, force: true });
} catch (error) {
  cleanupError = error instanceof Error ? error.message : String(error);
}

const ok = !timedOut && !spawnError && childExitCode === 0 && fixtureReport?.ok === true && !cleanupError;
const launcherReport = {
  ok,
  childExitCode,
  childSignal,
  timedOut,
  fixture: fixtureReport,
  temporaryDataCleaned: cleanupError === null,
  ...(spawnError ? { spawnError: spawnError.message } : {}),
  ...(reportParseError ? { reportParseError } : {}),
  ...(cleanupError ? { cleanupError } : {}),
  ...(!ok && stderr.trim() ? { stderr: stderr.trim().slice(-12000) } : {}),
  ...(!ok && !fixtureReport && stdout.trim() ? { stdout: stdout.trim().slice(-12000) } : {})
};

console.log(JSON.stringify(launcherReport, null, 2));
if (!ok) process.exitCode = 1;
