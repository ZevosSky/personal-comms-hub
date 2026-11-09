// Keyboard shortcuts (D11) and the application menu (D12). Electron-free: main feeds it the
// `before-input-event` input and runs the action it returns.
import { ZOOM_LIMITS, clampZoomFactor } from "./limits.js";

/**
 * Windows/Linux get no application menu, which removes Electron's default accelerators
 * (Ctrl+W closes the window, Ctrl+R reloads the shell, shell zoom). macOS keeps the app and edit
 * menus so Cmd+Q, Cmd+H and Cmd+C/V keep working.
 */
export const applicationMenuTemplate = (platform = process.platform) =>
  platform === "darwin" ? [{ role: "appMenu" }, { role: "editMenu" }] : null;

const letterOf = ({ key, code }) => {
  if (typeof key === "string" && /^[a-z]$/i.test(key)) return key.toLowerCase();
  return /^Key([A-Z])$/.exec(code ?? "")?.[1].toLowerCase() ?? null;
};

// The key's own digit first (numpad digits only with Num Lock on), else the top-row position for
// layouts such as AZERTY where those keys type symbols.
const digitOf = ({ key, code }) => {
  if (typeof key === "string" && /^[0-9]$/.test(key)) return Number(key);
  const match = /^Digit([0-9])$/.exec(code ?? "");
  return match ? Number(match[1]) : null;
};

const zoomDirectionOf = ({ key, code }) => {
  if (key === "=" || key === "+" || code === "Equal" || code === "NumpadAdd") return 1;
  if (key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract") return -1;
  return null;
};

// Held keys repeat only where repeating makes sense.
const repeatable = new Set(["zoom", "cycle", "back", "forward"]);

/**
 * Maps one keyboard input to an app action, or null to let the page have the key.
 * Actions: { action: "select", index } (0-based) | { action: "cycle", direction } |
 * { action: "reload", ignoreCache } | { action: "zoom", direction: 1 | -1 | 0 } | { action: "find" } |
 * { action: "back" } | { action: "forward" } | { action: "devtools" } | { action: "settings" }.
 * Ctrl+W is deliberately unmapped: it must never close or quit anything.
 */
export const resolveShortcut = (input, { platform = process.platform } = {}) => {
  if (!input || input.type !== "keyDown" || input.isComposing) return null;
  const mac = platform === "darwin";
  const { key, code } = input;
  const control = input.control === true;
  const meta = input.meta === true;
  const alt = input.alt === true;
  const shift = input.shift === true;
  // AltGr arrives as Ctrl+Alt on Windows, so Ctrl shortcuts require Alt to be up.
  const primary = mac ? meta && !control && !alt : control && !meta && !alt;
  const letter = letterOf(input);
  const digit = digitOf(input);
  let result = null;

  if (key === "F5" && !alt && !meta) result = { action: "reload", ignoreCache: control || shift };
  else if (key === "F12" && !control && !alt && !meta && !shift) result = { action: "devtools" };
  else if (key === "Tab" && control && !alt && !meta) result = { action: "cycle", direction: shift ? -1 : 1 };
  else if ((key === "PageDown" || key === "PageUp") && control && !alt && !meta && !shift) {
    result = { action: "cycle", direction: key === "PageDown" ? 1 : -1 };
  } else if (!mac && alt && !control && !meta && !shift && (key === "ArrowLeft" || key === "ArrowRight")) {
    result = { action: key === "ArrowLeft" ? "back" : "forward" };
  } else if (mac && meta && !control && !alt && !shift && (key === "[" || key === "]")) {
    result = { action: key === "[" ? "back" : "forward" };
  } else if (mac ? meta && alt && !control && letter === "i" : primary && shift && letter === "i") {
    result = { action: "devtools" };
  } else if (primary) {
    const zoom = zoomDirectionOf(input);
    if (zoom !== null) result = { action: "zoom", direction: zoom };
    else if (digit === 0 && !shift) result = { action: "zoom", direction: 0 };
    else if (digit !== null && digit >= 1) result = { action: "select", index: digit - 1 };
    else if (letter === "r") result = { action: "reload", ignoreCache: shift };
    else if (letter === "f" && !shift) result = { action: "find" };
    else if ((key === "," || code === "Comma") && !shift) result = { action: "settings" };
  }

  if (result && input.isAutoRepeat && !repeatable.has(result.action)) return null;
  return result;
};

/** Mouse back/forward buttons arrive as `app-command` on Windows and Linux. */
export const resolveAppCommand = (command) =>
  command === "browser-backward" ? "back" : command === "browser-forward" ? "forward" : null;

/** One zoom step in `direction` (0 resets), on the 10% grid the zoom buttons use. */
export const stepZoomFactor = (current, direction) => {
  if (direction === 0) return ZOOM_LIMITS.default;
  const steps = Math.round(clampZoomFactor(current) / ZOOM_LIMITS.step) + Math.sign(direction);
  return clampZoomFactor(Math.round(steps * ZOOM_LIMITS.step * 100) / 100);
};

const visibleIds = (services) => (services ?? []).filter((service) => service.isEnabled).map((service) => service.id);

/** The id of the nth (0-based) visible app, or null. */
export const serviceIdAtIndex = (services, index) => visibleIds(services)[index] ?? null;

/** The visible app `direction` steps from the selected one, wrapping around; null when none. */
export const cycleServiceId = (services, activeId, direction) => {
  const ids = visibleIds(services);
  if (!ids.length) return null;
  const current = ids.indexOf(activeId);
  if (current < 0) return ids[direction < 0 ? ids.length - 1 : 0];
  return ids[(current + Math.sign(direction) + ids.length) % ids.length];
};
