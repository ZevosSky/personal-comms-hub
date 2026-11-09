// Release-check helpers for the GitHub update prompt. Electron-free so they can be unit-tested.

export const normalizeVersion = (version) => String(version || "").replace(/^v/i, "").split("-")[0];

/** 1 when left is newer, -1 when older, 0 when equal (missing parts count as 0). */
export const compareVersions = (left, right) => {
  const parts = (version) => normalizeVersion(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
};

/** The installer asset for this platform from a GitHub release's asset list, or null. */
export const getPlatformAsset = (assets = [], platform = process.platform) => {
  const list = Array.isArray(assets) ? assets.filter((asset) => typeof asset?.name === "string") : [];
  if (platform === "win32") {
    return list.find((asset) =>
      asset.name.endsWith(".exe") && !asset.name.endsWith(".blockmap") && !asset.name.toLowerCase().includes("uninstaller")
    ) ?? null;
  }
  if (platform === "linux") return list.find((asset) => asset.name.endsWith(".AppImage")) ?? null;
  return null;
};
