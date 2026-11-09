// Started by app-shell.mjs as a second copy of the app on the same profile. main.js must hand
// over to the running copy and exit with code 0 without creating a window.
import { app } from "electron";

const userData = process.env.COMMS_ELECTRON_USER_DATA;
if (!userData) throw new Error("This fixture is started by tests/fixtures/app-shell.mjs.");
app.setPath("userData", userData);
app.on("browser-window-created", () => {
  console.log("SECOND_INSTANCE_CREATED_A_WINDOW");
  app.exit(3);
});
await import("../../electron/main.js");
