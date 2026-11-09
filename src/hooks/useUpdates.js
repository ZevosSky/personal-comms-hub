import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../lib/bridge.js";

// A hung IPC call (e.g. a stalled network request in main) must not keep "Checking…" up.
const CHECK_TIMEOUT_MS = 30000;

const withTimeout = (promise) => {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: new Error("The update server didn't respond in time.") }),
      CHECK_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Update check state. `checking` is always cleared, whatever the bridge does.
export function useUpdates({ run, notify, autoCheck }) {
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  const autoChecked = useRef(false);

  const check = useCallback(
    async ({ announce = true } = {}) => {
      if (busy.current) return;
      busy.current = true;
      setChecking(true);
      try {
        const result = await withTimeout(run("checkForUpdates", [], { applyResult: false, quiet: true }));
        if (!result.ok) {
          setInfo((previous) => ({
            ...previous,
            status: "error",
            error: result.unavailable ? "Update checks aren't available." : describeError(result.error)
          }));
          if (announce) notify("Unable to check for updates right now.", "error");
          return;
        }
        const value = result.value && typeof result.value === "object" ? result.value : { status: "error" };
        setInfo(value);
        if (!announce) return;
        if (value.status === "update-available") notify(`Update available: ${value.latestVersion}.`, "info");
        else if (value.status === "up-to-date") notify(`Comms Hub ${value.currentVersion} is up to date.`, "info");
        else if (value.status === "error") notify("Unable to check for updates right now.", "error");
      } finally {
        busy.current = false;
        setChecking(false);
      }
    },
    [run, notify]
  );

  const openDownload = useCallback(async () => {
    const result = await run("openUpdateDownload", [], { applyResult: false, failure: "Couldn't open the download" });
    if (result.ok && result.value) notify("Opened the latest release download.", "info");
    else if (result.ok) notify("No download is available right now.", "info");
  }, [run, notify]);

  useEffect(() => {
    if (!autoCheck || autoChecked.current) return;
    autoChecked.current = true;
    check({ announce: false });
  }, [autoCheck, check]);

  return { info, checking, check, openDownload };
}
