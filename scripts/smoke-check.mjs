import fs from "node:fs";
import path from "node:path";
import { APP_USER_MODEL_ID } from "../electron/appLifecycle.js";

const root = process.cwd();

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const readText = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

// Enough of electron-builder's `files` glob syntax for the patterns used here.
const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) =>
        part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      )
      .join("")}$`
  );
const isPackaged = (relativePath, files) => {
  const included = files.filter((pattern) => !pattern.startsWith("!"));
  const excluded = files.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  return included.some((pattern) => globToRegExp(pattern).test(relativePath)) &&
    !excluded.some((pattern) => globToRegExp(pattern).test(relativePath));
};

const packageJson = readJson(path.join(root, "package.json"));
const distIndexPath = path.join(root, "dist", "index.html");
assert(fs.existsSync(distIndexPath), "dist/index.html is missing. Run the build first.");
const distIndex = fs.readFileSync(distIndexPath, "utf8");
assert(distIndex.includes("./assets/"), "dist/index.html should reference relative ./assets paths.");

for (const relativePath of [
  "electron/main.js",
  "electron/bootstrap.js",
  "electron/appLifecycle.js",
  "electron/appIcon.js",
  "electron/trayController.js",
  "electron/preload.js",
  "electron/guestPreload.js",
  "electron/configStore.js",
  "electron/serviceManager.js",
  "electron/trigger.html",
  "electron/trigger-page.js",
  "build/icon.png",
  ".github/workflows/build-installers.yml"
]) {
  assert(fs.existsSync(path.join(root, relativePath)), `Required file is missing: ${relativePath}`);
}

const preloadSource = readText("electron/preload.js");
const mainSource = readText("electron/main.js");
const bootstrapSource = readText("electron/bootstrap.js");
const appIconSource = readText("electron/appIcon.js");
const workflowSource = readText(".github/workflows/build-installers.yml");

assert(packageJson.scripts?.build, "package.json is missing a build script.");
assert(packageJson.scripts?.smoke, "package.json is missing a smoke script.");
assert(packageJson.scripts?.["dist:win"], "package.json is missing a dist:win script.");
assert(packageJson.engines?.node, "package.json should declare the supported Node.js version in engines.");
assert(preloadSource.includes("refreshActiveWebview"), "preload should expose active webview refresh.");
assert(
  preloadSource.includes("setServiceViewport") && preloadSource.includes("getServiceRuntime"),
  "preload should expose managed service layout and runtime state."
);
assert(preloadSource.includes("ui:set-settings"), "preload should expose setAppSettings.");
for (const channel of [
  "services:sleep",
  "services:get-metrics",
  "app:set-overlay-badge",
  "services:navigate",
  "services:find",
  "services:stop-find",
  "services:context-menu"
]) {
  assert(preloadSource.includes(`"${channel}"`) && mainSource.includes(`"${channel}"`), `${channel} must be exposed and handled.`);
}
// Guest UX (D12, D15): no default menu, and guests never advertise Electron.
assert(mainSource.includes("Menu.setApplicationMenu("), "main should replace the default application menu.");
assert(mainSource.includes("app.userAgentFallback"), "main should set the clean guest user agent as the fallback.");
for (const relativePath of ["electron/shortcuts.js", "electron/contextMenu.js", "electron/popupPolicy.js", "electron/downloads.js"]) {
  assert(!/from\s+["']electron["']/.test(readText(relativePath)), `${relativePath} must stay Electron-free.`);
}
// The page's Notification API must be replaced before any page script runs (D3).
assert(readText("electron/guestPreload.js").includes("contextBridge.executeInMainWorld"), "guestPreload should install its page bridge in the main world.");
assert(
  mainSource.includes("webviews:refresh-active"),
  "main process should handle active service refresh requests."
);

// App identity and instance handling (D19, D22).
assert(packageJson.build?.appId === APP_USER_MODEL_ID, "build.appId must match the AppUserModelId main sets.");
assert(
  mainSource.match(/^import .*$/m)?.[0].includes('"./bootstrap.js"'),
  "electron/bootstrap.js must be main.js's first import."
);
assert(bootstrapSource.includes("requestSingleInstanceLock"), "bootstrap should claim the single-instance lock.");
assert(bootstrapSource.includes("app.isPackaged"), "--dev must be ignored in packaged builds.");
assert(mainSource.includes('"second-instance"'), "main should reveal the app on a second launch.");

// The tray/window icon must be inside the asar; electron-builder never packs buildResources.
const files = packageJson.build?.files ?? [];
assert(isPackaged("build/icon.png", files), "build/icon.png must be listed in build.files so the tray icon ships.");
assert(isPackaged("electron/main.js", files) && isPackaged("dist/index.html", files), "build.files must include electron/ and dist/.");
assert(appIconSource.includes('"build", "icon.png"'), "electron/appIcon.js should load build/icon.png.");

// Electron fuses for the packaged app (D20).
const fuses = packageJson.build?.electronFuses ?? {};
assert(fuses.runAsNode === false, "electronFuses.runAsNode must be false.");
assert(fuses.enableCookieEncryption === true, "electronFuses.enableCookieEncryption must be true.");
assert(fuses.enableNodeOptionsEnvironmentVariable === false, "electronFuses.enableNodeOptionsEnvironmentVariable must be false.");
assert(fuses.enableNodeCliInspectArguments === false, "electronFuses.enableNodeCliInspectArguments must be false.");
assert(fuses.onlyLoadAppFromAsar === true, "electronFuses.onlyLoadAppFromAsar must be true.");
assert(packageJson.build?.asar !== false, "onlyLoadAppFromAsar requires an asar package.");

// Vite bundles the renderer, so nothing ships in node_modules (D21).
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
for (const name of ["react", "react-dom", "uuid", "electron-store", "electron"]) {
  assert(!runtimeDependencies.includes(name), `${name} must not be a runtime dependency.`);
}
assert(packageJson.devDependencies?.electron, "electron should be a devDependency.");

// Release workflow: least privilege and a locked install.
assert(/^permissions:\s*\r?\n\s+contents: read\b/m.test(workflowSource), "The workflow's default token must be read-only.");
assert(!/\bnpm install\b/.test(workflowSource), "CI must install with npm ci.");
assert(workflowSource.includes("GITHUB_REF_NAME"), "Tag builds must check the tag against package.json's version.");

assert(packageJson.build?.win?.target, "Windows packaging target is missing.");
assert(packageJson.build?.nsis?.createStartMenuShortcut === true, "NSIS Start Menu shortcut should be enabled.");
assert(packageJson.build?.nsis?.createDesktopShortcut, "NSIS Desktop shortcut should be enabled.");

// Linux packaging is currently disabled; check its targets only while it is configured.
if (packageJson.build?.linux) {
  const linuxTargets = (packageJson.build.linux.target ?? []).map((target) =>
    typeof target === "string" ? target : target.target
  );
  assert(linuxTargets.includes("AppImage"), "Linux AppImage target is missing.");
  assert(linuxTargets.includes("tar.gz"), "Linux tar.gz fallback target is missing.");
}

console.log("Smoke checks passed.");
