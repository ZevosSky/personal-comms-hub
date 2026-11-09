import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const maxLogBytes = 256 * 1024;

/** Appends to <userData>/startup.log. Never throws. */
export const writeStartupDiagnostic = (message, error) => {
  const details = error instanceof Error ? `${error.stack || error.message}` : String(error ?? "");
  const entry = `[${new Date().toISOString()}] ${message}${details ? `\n${details}` : ""}\n\n`;
  if (error === undefined) console.error(message);
  else console.error(message, error);

  try {
    // userData is available before `ready` and honours any override set by the caller.
    const diagnosticsDir = app.getPath("userData");
    const logPath = path.join(diagnosticsDir, "startup.log");
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    // Keep the log bounded: the previous one is kept as startup.old.log.
    try {
      if ((fs.statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) > maxLogBytes) {
        fs.renameSync(logPath, path.join(diagnosticsDir, "startup.old.log"));
      }
    } catch {
      // Rotation is optional; appending below still records the entry.
    }
    fs.appendFileSync(logPath, entry, "utf8");
  } catch {
    // Diagnostics are best effort and must never cause a second crash.
  }
};
