// Defensive access to the preload bridge (window.commsApp). Every renderer call goes through
// here so a missing method (older main process) or a rejected IPC call never escapes as an
// unhandled rejection.

export const getBridge = () => (typeof window === "undefined" ? undefined : window.commsApp);

export const hasBridgeMethod = (name) => typeof getBridge()?.[name] === "function";

export class BridgeUnavailableError extends Error {
  constructor(method) {
    super("This action isn't available in this version of Comms Hub.");
    this.name = "BridgeUnavailableError";
    this.method = method;
  }
}

export const invokeBridge = async (method, ...args) => {
  const bridge = getBridge();
  if (typeof bridge?.[method] !== "function") {
    throw new BridgeUnavailableError(method);
  }
  return bridge[method](...args);
};

// Fire-and-forget calls (ipcRenderer.send based). Returns false when the call could not be made.
export const sendBridge = (method, ...args) => {
  const bridge = getBridge();
  if (typeof bridge?.[method] !== "function") return false;
  try {
    const result = bridge[method](...args);
    if (result && typeof result.then === "function") result.then(undefined, () => {});
    return true;
  } catch {
    return false;
  }
};

// Subscribes to a bridge event (onStateUpdated, onFindResult, ...). Always returns a callable
// unsubscribe, even when the event does not exist.
export const subscribeBridge = (eventName, callback) => {
  const bridge = getBridge();
  if (typeof bridge?.[eventName] !== "function") return () => {};
  let unsubscribe;
  try {
    unsubscribe = bridge[eventName](callback);
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch {
      // The bridge may already be gone during window teardown.
    }
  };
};

export const describeError = (error) => {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // ipcRenderer.invoke prefixes rejections with "Error invoking remote method '<channel>': Error: ".
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^(?:[A-Z]\w*)?Error:\s*/, "")
    .trim();
  return cleaned || "Something went wrong.";
};

export const isAppState = (value) =>
  Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray(value.services) &&
      value.ui &&
      typeof value.ui === "object"
  );
