// Validation for service data and icons that arrive from the renderer. Electron-free.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_NAME_MAX_LENGTH } from "./limits.js";
import { SERVICE_URL_MAX_LENGTH, parseUrl } from "./urlPolicy.js";

export const ICON_UPLOAD_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "gif", "webp", "ico", "svg"]);
// Decoded by nativeImage and re-encoded as a small PNG; the others are copied as they are.
export const ICON_RESIZABLE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg"]);
export const ICON_UPLOAD_MAX_BYTES = 1024 * 1024;
export const ICON_MAX_DIMENSION = 256;
const iconDataUrlMaxLength = 200000;
const iconDataUrlPattern = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;
const iconKeyPattern = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const notificationFlags = ["desktopEnabled", "badgeEnabled", "captureWebNotifications"];

/** Lower-case extension without the dot, or "" when the file has none. */
export const iconExtension = (filePath) => path.extname(String(filePath ?? "")).slice(1).toLowerCase();

/** Returns a user-facing reason the chosen file cannot be an icon, or null. */
export const iconUploadProblem = ({ extension, size, isFile = true }) => {
  if (!ICON_UPLOAD_EXTENSIONS.includes(extension)) return "Choose a PNG, JPEG, GIF, WebP, ICO or SVG image.";
  if (!isFile) return "Choose an image file.";
  if (!Number.isFinite(size) || size <= 0) return "That image file is empty.";
  if (size > ICON_UPLOAD_MAX_BYTES) return "Choose an image smaller than 1 MB.";
  return null;
};

/** Scales { width, height } down (never up) so neither side exceeds `max`, keeping the aspect ratio. */
export const fitWithin = ({ width, height }, max = ICON_MAX_DIMENSION) => {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

/** True when `filePath` lies strictly inside `directory` (case-insensitive on Windows). */
export const isPathInside = (filePath, directory, platform = process.platform) => {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = pathApi.relative(fold(pathApi.resolve(directory)), fold(pathApi.resolve(filePath)));
  return Boolean(relative) && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
};

// The server of a UNC directory (\\server\share\...), lower-cased, or null.
const uncServerOf = (directory) => /^\\\\([^\\]+)\\/.exec(path.win32.resolve(directory))?.[1].toLowerCase() ?? null;

/**
 * The path inside `iconsDir` that a file: icon URL names, or null. A URL with a host (a UNC
 * server) is accepted only on Windows when `iconsDir` itself is on that server, as with a
 * redirected AppData folder; every other host is refused so an icon cannot make Windows contact
 * another machine.
 */
export const uploadedIconPath = (value, { iconsDir, platform = process.platform } = {}) => {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== "file:" || !iconsDir) return null;
  const windows = platform === "win32";
  if (parsed.host && !(windows && parsed.hostname.toLowerCase() === uncServerOf(iconsDir))) return null;
  try {
    // Older builds stored "file://C:/..."; the drive letter then lands in the path either way.
    const filePath = fileURLToPath(`file://${parsed.host}${parsed.pathname}`, { windows });
    return isPathInside(filePath, iconsDir, platform) ? filePath : null;
  } catch {
    return null;
  }
};

/**
 * Icons the shell may render: a built-in library icon, a small image data URL, or a file the
 * app copied into userData/icons. Remote file URLs are refused (see uploadedIconPath).
 */
export const isAllowedIconSource = (value, { iconsDir, libraryIcons = [], platform = process.platform } = {}) => {
  if (typeof value !== "string" || !value) return false;
  if (libraryIcons.includes(value)) return true;
  if (iconDataUrlPattern.test(value)) return value.length <= iconDataUrlMaxLength;
  return uploadedIconPath(value, { iconsDir, platform }) !== null;
};

/**
 * Copies only the user-editable fields of a service sent by the renderer. Main owns the id of
 * new services and every code-owned field (isBuiltIn, sessionPartition, useDefaultSession,
 * userAgent, supportsBadgeDetection); normalizeService takes those from `existing` or derives them.
 * `input.url` must already be validated by the caller.
 */
export const sanitizeServiceInput = (input, existing = null, iconOptions = {}) => {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const service = {};
  if (existing) service.id = existing.id;
  if (typeof source.name === "string") service.name = source.name.trim().slice(0, SERVICE_NAME_MAX_LENGTH);
  if (typeof source.url === "string") service.url = source.url.trim().slice(0, SERVICE_URL_MAX_LENGTH);
  if (
    typeof source.iconSource === "string" &&
    (source.iconSource === existing?.iconSource || isAllowedIconSource(source.iconSource, iconOptions))
  ) {
    service.iconSource = source.iconSource;
  }
  // The key describes the icon it came with, so it is dropped along with a refused icon.
  const iconRefused = source.iconSource !== undefined && service.iconSource === undefined;
  if (!iconRefused && typeof source.iconKey === "string" && iconKeyPattern.test(source.iconKey)) service.iconKey = source.iconKey;
  for (const key of ["isEnabled", "keepAliveInBackground"]) {
    if (typeof source[key] === "boolean") service[key] = source[key];
  }
  if (typeof source.zoomFactor === "number" && Number.isFinite(source.zoomFactor)) service.zoomFactor = source.zoomFactor;
  if (source.notificationSettings && typeof source.notificationSettings === "object") {
    const flags = Object.fromEntries(
      notificationFlags
        .filter((key) => typeof source.notificationSettings[key] === "boolean")
        .map((key) => [key, source.notificationSettings[key]])
    );
    // Partial updates keep the other flags instead of resetting them to defaults.
    service.notificationSettings = { ...(existing?.notificationSettings ?? {}), ...flags };
  }
  return service;
};
