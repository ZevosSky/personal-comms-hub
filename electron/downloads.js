// Downloads from services (D8): straight to the Downloads folder under a unique name, or the
// Save As dialog when the user asked for it. Electron-free: the DownloadItem and the file system
// checks are injected.
import path from "node:path";

const reservedNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const doubleExtensions = /\.tar\.(?:gz|bz2|xz|zst)$/i;
const maxNameLength = 200;

/** A plain file name that is safe on every platform; never a path. */
export const safeDownloadName = (name) => {
  let result = String(name ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*\u007f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!result || result === "." || result === "..") result = "download";
  if (reservedNames.test(result)) result = `_${result}`;
  if (result.length > maxNameLength) {
    const extension = path.extname(result).slice(0, 20);
    result = result.slice(0, maxNameLength - extension.length) + extension;
  }
  return result;
};

/** "name.ext", else "name (1).ext", "name (2).ext", ... the first that `isTaken` rejects. */
export const uniqueDownloadPath = (directory, name, isTaken, pathApi = path) => {
  const fileName = safeDownloadName(name);
  const extension = doubleExtensions.exec(fileName)?.[0] ?? pathApi.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 0; index < 10000; index += 1) {
    const candidate = pathApi.join(directory, index ? `${stem} (${index})${extension}` : fileName);
    if (!isTaken(candidate)) return candidate;
  }
  return pathApi.join(directory, `${stem} (${Date.now()})${extension}`);
};

/**
 * Handles each Electron DownloadItem (call `handle(item)` synchronously from `will-download`).
 * setProgress(fraction 0..1 | "indeterminate" | null) reports the combined progress of all active
 * downloads; null when none is left.
 *
 * A network drop ends at 'updated' with state 'interrupted' and no 'done': Chromium keeps the item
 * waiting for a resume() that nothing here offers. Such an item fails at once when it cannot
 * resume, or after `interruptedGraceMs` if it is still interrupted; it is then cancelled so the
 * partial file goes away. Each download reports completed or failed at most once.
 */
export function createDownloadManager({
  getDirectory,
  askWhereToSave = () => false,
  isTaken = () => false,
  prepareDirectory = () => {},
  setProgress = () => {},
  onCompleted = () => {},
  onFailed = () => {},
  log = () => {},
  pathApi = path,
  interruptedGraceMs = 10000,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const active = new Map();
  const reserved = new Set();
  const fold = (value) => value.toLowerCase();

  const reportProgress = () => {
    if (!active.size) return setProgress(null);
    let received = 0;
    let total = 0;
    for (const item of active.keys()) {
      const itemTotal = Number(item.getTotalBytes?.()) || 0;
      if (itemTotal <= 0) return setProgress("indeterminate");
      total += itemTotal;
      received += Math.min(itemTotal, Number(item.getReceivedBytes?.()) || 0);
    }
    return setProgress(total ? received / total : "indeterminate");
  };

  const handle = (item) => {
    const name = safeDownloadName(item.getFilename?.());
    let directory = null;
    try {
      directory = getDirectory();
    } catch (error) {
      log("Could not find the Downloads folder.", error);
    }
    let savePath = null;
    if (askWhereToSave() || !directory) {
      // No save path: Chromium shows the Save As dialog, starting in the Downloads folder.
      if (directory) item.setSaveDialogOptions?.({ defaultPath: pathApi.join(directory, name) });
    } else {
      try {
        prepareDirectory(directory);
      } catch (error) {
        log("Could not create the Downloads folder.", error);
      }
      savePath = uniqueDownloadPath(directory, name, (candidate) => reserved.has(fold(candidate)) || isTaken(candidate), pathApi);
      reserved.add(fold(savePath));
      item.setSavePath(savePath);
    }

    active.set(item, savePath);
    let finished = false;
    let stallTimer = null;
    const stopStallTimer = () => {
      if (stallTimer) clearTimer(stallTimer);
      stallTimer = null;
    };
    const finish = (state) => {
      if (finished) return;
      finished = true;
      stopStallTimer();
      active.delete(item);
      if (savePath) reserved.delete(fold(savePath));
      reportProgress();
      const finalPath = item.getSavePath?.() || savePath;
      const fileName = finalPath ? pathApi.basename(finalPath) : name;
      if (state === "completed") onCompleted({ fileName, savePath: finalPath });
      else if (state === "interrupted") onFailed({ fileName });
    };
    const giveUp = () => {
      if (finished) return;
      finish("interrupted");
      // Outside Chromium's update callback. Its 'done' (cancelled) is ignored: already reported.
      setTimer(() => {
        try {
          if ((item.getState?.() ?? "interrupted") === "interrupted") item.cancel?.();
        } catch (error) {
          log("Could not discard an interrupted download.", error);
        }
      }, 0);
    };
    item.on("updated", (_event, state) => {
      if (finished) return;
      if (state !== "interrupted") stopStallTimer();
      else if (!item.canResume?.()) giveUp();
      else if (!stallTimer) {
        stallTimer = setTimer(() => {
          stallTimer = null;
          if ((item.getState?.() ?? "interrupted") === "interrupted") giveUp();
        }, interruptedGraceMs);
      }
      if (!finished) reportProgress();
    });
    item.once("done", (_event, state) => finish(state));
    reportProgress();
    return savePath;
  };

  return { handle, activeCount: () => active.size };
}
