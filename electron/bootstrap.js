// Evaluated first (main.js imports it before anything else), so the profile is final and the
// single-instance lock is claimed before any module reads or writes userData.
import { app } from "electron";
import { APP_USER_MODEL_ID, isDevRun, resolveDevUserDataPath } from "./appLifecycle.js";

export const isDev = isDevRun({ isPackaged: app.isPackaged, argv: process.argv });

// Unpackaged runs get their own profile ("Comms Hub Dev" with --dev, else "Comms Hub Local") so
// in-progress changes never touch the installed app's settings and sign-ins, and so both can run
// at once (D19).
const devUserData = resolveDevUserDataPath({
  isPackaged: app.isPackaged,
  isDev,
  userData: app.getPath("userData"),
  appData: app.getPath("appData"),
  appName: app.getName()
});
if (devUserData) app.setPath("userData", devUserData);

// Toasts and the taskbar group under the installed shortcut's identity (D22). Unpackaged runs
// have no such shortcut, so they keep an identity of their own.
if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);
}

/** False in a second copy of the app: it must hand over to the first one and exit. */
export const hasInstanceLock = app.requestSingleInstanceLock();
