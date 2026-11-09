// Removing a custom app (D7): the confirm dialog and what may be wiped. Electron-free.
import path from "node:path";
import { uploadedIconPath } from "./serviceInput.js";

export const WIPE_DATA_LABEL = "Also delete its sign-in data and cache";

/** The app's uploaded icon as a path inside `iconsDir`, or null (library icons, data URLs, elsewhere). */
export const iconFileFromSource = (iconSource, { iconsDir, platform = process.platform }) =>
  uploadedIconPath(iconSource, { iconsDir, platform });

const samePath = (left, right, platform) => {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const fold = (value) => (platform === "win32" ? pathApi.resolve(value).toLowerCase() : pathApi.resolve(value));
  return fold(left) === fold(right);
};

/**
 * The uploaded file behind `iconSource` when none of `services` still shows it, else null.
 * Compares resolved paths, so the old "file://C:/..." and new "file:///C:/..." forms of one file match.
 */
export const unusedIconFile = (iconSource, { services = [], iconsDir = null, platform = process.platform }) => {
  const filePath = iconFileFromSource(iconSource, { iconsDir, platform });
  if (!filePath) return null;
  const inUse = services.some((service) => {
    const other = iconFileFromSource(service.iconSource, { iconsDir, platform });
    return other !== null && samePath(other, filePath, platform);
  });
  return inUse ? null : filePath;
};

/**
 * What removing `target` may clean up, given every service before removal:
 * - `partition`: its own persistent partition, unless it uses the default session or shares the
 *   partition with another app (the default session is never wiped);
 * - `iconPath`: its uploaded icon file, unless another app shows the same icon.
 */
export const removalPlan = ({ target, services = [], iconsDir = null, platform = process.platform }) => {
  const others = services.filter((service) => service.id !== target.id);
  const partition =
    typeof target.sessionPartition === "string" && target.sessionPartition && !target.useDefaultSession &&
    !others.some((service) => !service.useDefaultSession && service.sessionPartition === target.sessionPartition)
      ? target.sessionPartition
      : null;
  const iconPath = unusedIconFile(target.iconSource, { services: others, iconsDir, platform });
  return { partition, iconPath };
};

/** The native confirm. The wipe checkbox starts unchecked and only appears when there is data to wipe. */
export const removeConfirmOptions = ({ name, canWipeData }) => ({
  type: "warning",
  title: "Remove app",
  message: `Remove ${name}?`,
  detail: canWipeData
    ? "It is removed from Comms Hub on this device. Its sign-in data stays unless you delete it below."
    : "It is removed from Comms Hub on this device.",
  buttons: ["Remove", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  ...(canWipeData ? { checkboxLabel: WIPE_DATA_LABEL, checkboxChecked: false } : {})
});
