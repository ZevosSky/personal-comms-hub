import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeImage } from "electron";
import { writeStartupDiagnostic } from "./diagnostics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Packaged via package.json build.files; electron-builder never packs buildResources itself. */
export const appIconPath = path.join(__dirname, "..", "build", "icon.png");

// A 32 px copy of build/icon.png, used only if that file cannot be read.
const fallbackIconDataUrl =
  "data:image/png;base64,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";

// Tray sizes per display scale, so the icon stays sharp at 125-200% instead of being stretched.
const trayRepresentations = process.platform === "darwin"
  ? [[1, 16], [2, 32]]
  : [[1, 16], [1.25, 20], [1.5, 24], [2, 32]];

let appIcon = null;
let trayIcon = null;

/** The window/taskbar icon. Never empty. */
export const getAppIcon = () => {
  if (appIcon) return appIcon;
  const fromFile = nativeImage.createFromPath(appIconPath);
  if (fromFile.isEmpty()) {
    writeStartupDiagnostic(`App icon could not be loaded from ${appIconPath}; using the built-in fallback.`);
    appIcon = nativeImage.createFromDataURL(fallbackIconDataUrl);
  } else {
    appIcon = fromFile;
  }
  return appIcon;
};

/** The notification-area icon with one representation per common display scale. */
export const getTrayIcon = () => {
  if (trayIcon) return trayIcon;
  const source = getAppIcon();
  const image = nativeImage.createEmpty();
  for (const [scaleFactor, size] of trayRepresentations) {
    image.addRepresentation({ scaleFactor, buffer: source.resize({ width: size, height: size, quality: "best" }).toPNG() });
  }
  trayIcon = image.isEmpty() ? source.resize({ width: 16, height: 16 }) : image;
  return trayIcon;
};
