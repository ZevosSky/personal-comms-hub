import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeError,
  getBridge,
  hasBridgeMethod,
  invokeBridge,
  isAppState,
  subscribeBridge
} from "../lib/bridge.js";
import { useLatest } from "./useLatest.js";

const EMPTY_RUNTIME = { services: {} };

// App state + service runtime, kept in sync with main.
//
// Ordering guard. Main coalesces `state:updated` into one broadcast per tick (sent on the next
// tick, skipped when nothing changed), and invoke handlers resolve the state as of their reply, so
// a reply usually arrives before the broadcast that carries the same change. Replies and
// broadcasts share one ordered IPC channel, so arrival order is main's order:
// - broadcasts always apply;
// - a returned state applies only if no broadcast arrived while the call was in flight. If one
//   did, the reply may predate it (a handler that snapshots state and then awaits), so it is
//   dropped and the UI waits for the next broadcast, which main sends whenever the state differs
//   from the last broadcast.
// Replies of other in-flight calls don't block each other: with skipped no-op broadcasts, two
// quick toggles (on, off) would otherwise leave the first reply on screen with no broadcast to
// correct it.
export function useAppRuntime({ notify, withRuntime = true } = {}) {
  const [appState, setAppState] = useState(null);
  const [runtime, setRuntime] = useState(EMPTY_RUNTIME);
  const [loadError, setLoadError] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const broadcastVersion = useRef(0);
  const runtimeVersion = useRef(0);
  const notifyRef = useLatest(notify);

  useEffect(() => {
    let active = true;
    if (!getBridge()) {
      setLoadError("Comms Hub couldn't connect to its main process. Restart the app to try again.");
      return undefined;
    }

    const unsubscribeState = subscribeBridge("onStateUpdated", (state) => {
      if (!isAppState(state)) return;
      broadcastVersion.current += 1;
      setAppState(state);
      setLoadError(null);
    });
    const unsubscribeRuntime = withRuntime
      ? subscribeBridge("onServiceRuntimeUpdated", (next) => {
          if (!next || typeof next !== "object") return;
          runtimeVersion.current += 1;
          setRuntime(next);
        })
      : () => {};

    const stateAtStart = broadcastVersion.current;
    const runtimeAtStart = runtimeVersion.current;
    (async () => {
      try {
        const [state, nextRuntime] = await Promise.all([
          invokeBridge("getState"),
          withRuntime && hasBridgeMethod("getServiceRuntime")
            ? invokeBridge("getServiceRuntime").catch(() => null)
            : null
        ]);
        if (!active) return;
        if (broadcastVersion.current === stateAtStart) {
          if (!isAppState(state)) throw new Error("Main returned an unexpected app state.");
          setAppState(state);
        }
        if (nextRuntime && typeof nextRuntime === "object" && runtimeVersion.current === runtimeAtStart) {
          setRuntime(nextRuntime);
        }
      } catch (error) {
        if (active && broadcastVersion.current === stateAtStart) {
          setLoadError(`Unable to load Comms Hub: ${describeError(error)}`);
        }
      }
    })();

    return () => {
      active = false;
      unsubscribeState();
      unsubscribeRuntime();
    };
  }, [withRuntime, loadAttempt]);

  // Single wrapper for bridge calls: feature-detects, applies a returned state (see ordering guard),
  // reports failures as an error status and never rejects.
  const run = useCallback(
    async (method, args = [], { success, failure, quiet = false, applyResult = true } = {}) => {
      const report = (text, tone) => {
        if (!quiet && text) notifyRef.current?.(text, tone);
      };
      if (!hasBridgeMethod(method)) {
        report("That action isn't available in this version of Comms Hub.", "error");
        return { ok: false, unavailable: true, value: undefined };
      }
      const versionAtCall = broadcastVersion.current;
      try {
        const value = await invokeBridge(method, ...args);
        if (applyResult && isAppState(value) && broadcastVersion.current === versionAtCall) {
          setAppState(value);
        }
        const message = typeof success === "function" ? success(value) : success;
        if (message && notifyRef.current) notifyRef.current(message, "info");
        return { ok: true, value };
      } catch (error) {
        report(failure ? `${failure}: ${describeError(error)}` : describeError(error), "error");
        return { ok: false, error, value: undefined };
      }
    },
    [notifyRef]
  );

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  return { appState, runtime, loadError, retryLoad, run };
}
