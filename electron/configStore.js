import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { app, nativeImage } from "electron";
import { validateConfigShape } from "./appStateModel.js";
import { createJsonFileBacking } from "./configPersistence.js";
import { createConfigStore } from "./configStoreCore.js";
import { writeStartupDiagnostic } from "./diagnostics.js";
import { ICON_RESIZABLE_EXTENSIONS, fitWithin, iconExtension, iconUploadProblem } from "./serviceInput.js";

export { builtInServices, iconLibrary } from "./appStateModel.js";

const configFileName = "comms-app-config.json";
let store = null;

// Created on first use so the userData path (possibly overridden by tests or a dev profile)
// is final, and so a bad file is handled with diagnostics instead of failing module import.
const getStore = () => {
  store ??= createConfigStore({
    backing: createJsonFileBacking({
      filePath: path.join(app.getPath("userData"), configFileName),
      validate: validateConfigShape
    }),
    platform: process.platform,
    log: writeStartupDiagnostic
  });
  return store;
};

export const getAppState = () => getStore().getAppState();
export const setUiState = (uiUpdates) => getStore().setUiState(uiUpdates);
export const setAppSettings = (partial) => getStore().setAppSettings(partial);
export const upsertService = (partialService) => getStore().upsertService(partialService);
export const removeService = (serviceId) => getStore().removeService(serviceId);
export const reorderServices = (serviceIds) => getStore().reorderServices(serviceIds);
export const getPermissionDecision = (serviceId, origin, permission) =>
  getStore().getPermissionDecision(serviceId, origin, permission);
export const setPermissionDecision = (serviceId, origin, permission, decision) =>
  getStore().setPermissionDecision(serviceId, origin, permission, decision);
export const clearPermissionDecisions = (serviceId) => getStore().clearPermissionDecisions(serviceId);
export const hasPermissionDecisions = (serviceId) => getStore().hasPermissionDecisions(serviceId);
export const getMainWindowState = () => getStore().getMainWindowState();
export const setMainWindowState = (windowState) => getStore().setMainWindowState(windowState);

export const getConfigLoadIssue = () => getStore().getLoadIssue();

/** Writes any debounced change synchronously. Call before the process exits. */
export const flushPendingWrites = () => store?.flush() ?? true;

export const getIconsDirectory = () => path.join(app.getPath("userData"), "icons");

/**
 * Copies a user-chosen icon into userData/icons and returns its file URL. Throws an Error with a
 * user-facing message for unsupported, oversized or unreadable files. PNG and JPEG icons are
 * re-encoded at most 256 px so every window decodes a small image.
 */
export const copyIconToUserData = (sourcePath) => {
  const extension = iconExtension(sourcePath);
  let stats = null;
  try {
    stats = fs.statSync(sourcePath);
  } catch {
    throw new Error("That image could not be read.");
  }
  const problem = iconUploadProblem({ extension, size: stats.size, isFile: stats.isFile() });
  if (problem) throw new Error(problem);

  const iconsDir = getIconsDirectory();
  fs.mkdirSync(iconsDir, { recursive: true });
  let destinationPath;
  if (ICON_RESIZABLE_EXTENSIONS.includes(extension)) {
    const image = nativeImage.createFromPath(sourcePath);
    const size = image.isEmpty() ? null : fitWithin(image.getSize());
    if (!size) throw new Error("That image could not be read.");
    destinationPath = path.join(iconsDir, `${randomUUID()}.png`);
    const { width, height } = image.getSize();
    const scaled = size.width === width && size.height === height ? image : image.resize({ ...size, quality: "best" });
    fs.writeFileSync(destinationPath, scaled.toPNG());
  } else {
    destinationPath = path.join(iconsDir, `${randomUUID()}.${extension}`);
    fs.copyFileSync(sourcePath, destinationPath);
  }
  return pathToFileURL(destinationPath).href;
};
