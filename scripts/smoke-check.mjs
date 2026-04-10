import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const packageJson = readJson(path.join(root, "package.json"));
const distIndexPath = path.join(root, "dist", "index.html");
const distIndex = fs.readFileSync(distIndexPath, "utf8");

assert(fs.existsSync(distIndexPath), "dist/index.html is missing. Run the build first.");
assert(distIndex.includes("./assets/"), "dist/index.html should reference relative ./assets paths.");

for (const relativePath of [
  "electron/main.js",
  "electron/preload.js",
  "electron/guestPreload.js",
  "electron/configStore.js",
  "build/icon.png",
  ".github/workflows/build-installers.yml"
]) {
  assert(fs.existsSync(path.join(root, relativePath)), `Required file is missing: ${relativePath}`);
}

assert(packageJson.scripts?.build, "package.json is missing a build script.");
assert(packageJson.scripts?.smoke, "package.json is missing a smoke script.");
assert(packageJson.scripts?.["dist:win"], "package.json is missing a dist:win script.");
assert(packageJson.scripts?.["dist:linux"], "package.json is missing a dist:linux script.");

assert(packageJson.build?.win?.target, "Windows packaging target is missing.");
assert(packageJson.build?.linux?.target, "Linux packaging target is missing.");
assert(packageJson.build?.nsis?.createStartMenuShortcut === true, "NSIS Start Menu shortcut should be enabled.");
assert(packageJson.build?.nsis?.createDesktopShortcut, "NSIS Desktop shortcut should be enabled.");

console.log("Smoke checks passed.");
