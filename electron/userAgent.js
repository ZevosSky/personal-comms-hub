// The guest user agent (D15). Electron-free.

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Electron's user agent with the `Electron/x` and app-name tokens removed and the Chrome token in
 * Chrome's reduced form (`Chrome/<major>.0.0.0`), so services see an ordinary current Chrome.
 * `appNames` are the names Electron may have inserted (app name, package name, product name).
 */
export const cleanUserAgent = (userAgent, { chromeVersion, appNames = [] } = {}) => {
  let result = String(userAgent ?? "");
  result = result.replace(/\sElectron\/\S+/g, "");
  for (const name of new Set(appNames.filter((value) => typeof value === "string" && value.trim()))) {
    result = result.replace(new RegExp(`\\s${escapeRegExp(name.trim())}/\\S+`, "g"), "");
  }
  const major = /^(\d+)/.exec(String(chromeVersion ?? ""))?.[1];
  if (major) result = result.replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`);
  return result.replace(/\s{2,}/g, " ").trim();
};
