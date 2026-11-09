// Pure (Electron-free) helpers for app-level behaviour: the dev profile, starting hidden,
// the login item and the tray. electron/bootstrap.js and main.js bind them to Electron.
import path from "node:path";

/** Matches package.json build.appId and the installer's shortcuts (D22). */
export const APP_USER_MODEL_ID = "com.garyyang.commshub";
export const DEV_PROFILE_NAME = "Comms Hub Dev";
/** Profile of other unpackaged runs (`npm start`), so they never open the installed app's data. */
export const LOCAL_PROFILE_NAME = "Comms Hub Local";
/** Passed by the login item; also usable from a shortcut to start in the tray. */
export const START_HIDDEN_ARG = "--hidden";

/** --dev is honoured only in unpackaged runs (D19). */
export const isDevRun = ({ isPackaged, argv = [] }) => !isPackaged && argv.includes("--dev");

const samePath = (left, right) => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};

/**
 * The userData folder an unpackaged run should switch to, or null to keep the current one:
 * "Comms Hub Dev" for --dev runs, "Comms Hub Local" for the others. The installed build turns on
 * cookie encryption (D20) and plain Electron does not, so sharing its profile would delete every
 * sign-in. A folder that was already overridden (tests, --user-data-dir) is never replaced.
 */
export const resolveDevUserDataPath = ({ isPackaged, isDev, userData, appData, appName }) => {
  if (isPackaged || !userData || !appData || !appName) return null;
  if (!samePath(userData, path.join(appData, appName))) return null;
  return path.join(appData, isDev ? DEV_PROFILE_NAME : LOCAL_PROFILE_NAME);
};

/** Start in the tray when launched at login or when the user asked to start minimized. */
export const shouldStartHidden = ({ argv = [], startMinimized = false, wasOpenedAtLogin = false }) =>
  argv.includes(START_HIDDEN_ARG) || wasOpenedAtLogin === true || startMinimized === true;

/**
 * Arguments for app.setLoginItemSettings, or null where registering would be wrong: dev runs
 * (it would register the bare Electron binary) and Linux (unsupported by Electron).
 */
export const loginItemSettingsFor = ({ platform, isPackaged, execPath, openAtLogin }) => {
  if (!isPackaged) return null;
  if (platform === "win32") {
    return { openAtLogin: Boolean(openAtLogin), path: execPath, args: [START_HIDDEN_ARG], name: APP_USER_MODEL_ID };
  }
  if (platform === "darwin") return { openAtLogin: Boolean(openAtLogin) };
  return null;
};

const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

/**
 * Total unread across enabled services, counted like the rail badge (D5): the title-parsed count
 * when the service reports one, otherwise its unseen notifications.
 */
export const countUnread = ({ services = [], badgeCounts = {}, unseenNotificationCounts = {} } = {}) =>
  services.reduce((total, service) => {
    if (!service?.isEnabled) return total;
    const badge = count(badgeCounts[service.id]);
    return total + (badge > 0 ? badge : count(unseenNotificationCounts[service.id]));
  }, 0);

export const trayToolTip = (unread) => {
  const total = count(unread);
  return total > 0 ? `Comms Hub - ${total > 999 ? "999+" : total} unread` : "Comms Hub";
};

/**
 * The tray menu for the current window mode. Items carry an `action` instead of a click handler
 * so the shape can be tested; handlers read fresh state when clicked.
 */
export const trayMenuModel = ({ windowMode, dockModeSupported }) => [
  { action: "open-full", label: "Open full app" },
  !dockModeSupported
    ? { label: "Dock mode unavailable on Linux", enabled: false }
    : windowMode === "dock"
      ? { action: "show-dock", label: "Show dock" }
      : { action: "enter-dock", label: "Enter dock mode" },
  { type: "separator" },
  { action: "quit", label: "Quit Comms Hub" }
];
