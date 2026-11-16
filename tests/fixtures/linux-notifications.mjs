import assert from "node:assert/strict";
import path from "node:path";
import { app, Notification } from "electron";

// Runs against the private D-Bus session and notification daemon provided by the Linux
// desktop test wrapper. Unlike app-shell.mjs, this fixture never replaces native APIs.
const userData = process.env.COMMS_ELECTRON_USER_DATA;
if (!userData) throw new Error("Start this fixture using scripts/run-electron-tests.mjs.");
app.setPath("userData", userData);
app.setPath("sessionData", path.join(userData, "sessions"));

const waitForNotification = (notification, eventName, action) => new Promise((resolve, reject) => {
  const finish = (error) => {
    clearTimeout(timer);
    notification.removeListener(eventName, onEvent);
    notification.removeListener("failed", onFailed);
    if (error) reject(error);
    else resolve();
  };
  const onEvent = () => finish();
  const onFailed = (_event, error) => finish(new Error(`Native Linux notification failed: ${String(error ?? "unknown error")}`));
  const timer = setTimeout(() => finish(new Error(
    `Timed out waiting for native notification ${eventName}; run inside the Linux desktop wrapper with a notification daemon.`
  )), 8000);
  notification.once(eventName, onEvent);
  notification.once("failed", onFailed);
  try { action(); } catch (error) { finish(error); }
});

app.whenReady().then(async () => {
  let notification;
  let report;
  try {
    if (process.platform !== "linux") {
      report = { ok: true, platform: process.platform, skipped: "Native Linux notification coverage only" };
    } else {
      assert.equal(Notification.isSupported(), true,
        "Native Linux notifications are unavailable. Install libnotify4 and run with scripts/run-linux-desktop-tests.sh.");
      notification = new Notification({
        title: `Comms Hub native notification test ${process.pid}-${Date.now()}`,
        body: "Synthetic local test; no account or message data.",
        silent: true,
        timeoutType: "never"
      });
      await waitForNotification(notification, "show", () => notification.show());
      // Electron detaches its delegate when close() is called, so an asynchronous Linux
      // daemon dismissal need not emit a JavaScript close event.
      notification.close();
      notification = null;
      report = {
        ok: true,
        platform: process.platform,
        tests: [{ name: "native Linux notification is delivered and close is requested", ok: true }]
      };
    }
  } catch (error) {
    report = { ok: false, platform: process.platform, error: error.stack || String(error) };
  } finally {
    notification?.close();
  }
  console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify(report)}`);
  setTimeout(() => app.exit(report.ok ? 0 : 1), 50);
}).catch((error) => {
  console.log(`COMMS_ELECTRON_TEST_REPORT ${JSON.stringify({ ok: false, error: error.stack || String(error) })}`);
  app.exit(1);
});
