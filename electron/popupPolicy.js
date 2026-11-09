// Which window.open() calls from a service become child windows (D13). Electron-free.
import { createRateLimiter } from "./linkPolicy.js";
import { parseUrl } from "./urlPolicy.js";

/** Sign-in pages that services open as popups and that need the service's session and opener. */
export const IDENTITY_PROVIDER_HOSTS = Object.freeze([
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com"
]);

export const POPUP_DEFAULT_SIZE = Object.freeze({ width: 1000, height: 760 });
export const POPUP_MIN_SIZE = Object.freeze({ width: 360, height: 320 });
/** Per service: at most `maxOpen` popups open at once, and at most `count` new ones per `windowMs`. */
export const POPUP_LIMITS = Object.freeze({ maxOpen: 5, count: 10, windowMs: 30000 });
// An admitted window.open() holds an open slot until its window exists, or for this long.
const POPUP_PENDING_MS = 5000;

const isWeb = (parsed) => Boolean(parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname);

/**
 * A blank popup's first navigation is judged like the window.open() it stands for: pages often
 * open a blank window and then set its location to an outside link. Returns true when that
 * navigation should go to the link policy (and the blank window close) instead.
 */
export const blankPopupLeavesApp = ({ url, openerUrl = null, serviceUrl = null }) =>
  !isBlankPopupUrl(url) && decideWindowOpen({ url, openerUrl, serviceUrl }) === "external";

/**
 * A popup's later navigation that it did not start itself (its opener or another window set its
 * location) is judged like a new window.open() from the owning service page. Returns true when it
 * should go to the link policy (and the popup close). Navigations the popup starts itself (links
 * in it, sign-in redirects between identity providers) stay in the popup.
 */
export const popupNavigationLeavesApp = ({ url, initiatedBySelf = false, ownerUrl = null, serviceUrl = null }) =>
  !initiatedBySelf && decideWindowOpen({ url, openerUrl: ownerUrl, serviceUrl }) === "external";

/**
 * "popup": open a child window that keeps the session and `window.opener` (same-origin pages,
 * about:blank pop-outs such as Gmail's compose window, identity providers).
 * "external": hand the URL to the link policy. A popup is never loaded into the service's view.
 */
/** window.open() with no URL (or about:blank): the opener fills the window in itself. */
export const isBlankPopupUrl = (url) => {
  const target = typeof url === "string" ? url.trim() : "";
  return !target || target === "about:blank";
};

export const decideWindowOpen = ({ url, openerUrl = null, serviceUrl = null }) => {
  if (isBlankPopupUrl(url)) return "popup";
  const parsed = parseUrl(url.trim());
  if (!isWeb(parsed)) return "external";
  if (IDENTITY_PROVIDER_HOSTS.includes(parsed.hostname.toLowerCase())) return "popup";
  const sameOrigin = (other) => {
    const reference = parseUrl(other);
    return isWeb(reference) && reference.origin === parsed.origin;
  };
  return sameOrigin(openerUrl) || sameOrigin(serviceUrl) ? "popup" : "external";
};

/** True for the identity providers' sign-in pages, which D13 lets open as popups. */
export const isIdentityProviderUrl = (url) => {
  const parsed = parseUrl(typeof url === "string" ? url.trim() : "");
  return isWeb(parsed) && parsed.protocol === "https:" && IDENTITY_PROVIDER_HOSTS.includes(parsed.hostname.toLowerCase());
};

/** A number the page gave in its window.open() features (first of `names`, any case), else null. */
const featureNumber = (features, names) => {
  for (const name of names) {
    const match = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(-?\\d+)`, "i").exec(String(features ?? ""));
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
};

const validArea = (area) =>
  area && [area.x, area.y, area.width, area.height].every(Number.isFinite) && area.width > 0 && area.height > 0 ? area : null;

/**
 * Fits a popup's bounds into a display's work area: the size is kept between the popup minimum and
 * the work area, and the whole window is moved inside it. A missing x or y centres the window on
 * that axis. Without a usable work area only the minimum size applies and x/y are left unset.
 */
export const clampPopupBounds = ({ x = null, y = null, width = null, height = null } = {}, workArea = null) => {
  const area = validArea(workArea);
  const size = (wanted, fallback, min, room) =>
    Math.round(Math.min(Math.max(Number.isFinite(wanted) ? wanted : fallback, min), room));
  const place = (wanted, length, start, room) => Number.isFinite(wanted)
    ? Math.round(Math.min(Math.max(wanted, start), start + room - length))
    : Math.round(start + (room - length) / 2);
  const fitWidth = size(width, POPUP_DEFAULT_SIZE.width, POPUP_MIN_SIZE.width, area ? area.width : Infinity);
  const fitHeight = size(height, POPUP_DEFAULT_SIZE.height, POPUP_MIN_SIZE.height, area ? area.height : Infinity);
  return {
    x: area ? place(x, fitWidth, area.x, area.width) : undefined,
    y: area ? place(y, fitHeight, area.y, area.height) : undefined,
    width: fitWidth,
    height: fitHeight
  };
};

// Electron builds a popup from the page's parsed window.open() features and then applies these
// options, so every window-chrome option a page could use (no frame, always on top, full screen,
// kiosk, not closable, hidden from the taskbar, see-through) is set here and the page's value never
// survives. `undefined` drops the page's value and keeps Electron's default.
const POPUP_CHROME = Object.freeze({
  frame: true,
  transparent: false,
  alwaysOnTop: false,
  fullscreen: false,
  fullscreenable: true,
  kiosk: false,
  simpleFullscreen: false,
  closable: true,
  minimizable: true,
  maximizable: true,
  resizable: true,
  movable: true,
  focusable: true,
  skipTaskbar: false,
  opacity: 1,
  hasShadow: true,
  thickFrame: true,
  enableLargerThanScreen: false,
  titleBarStyle: "default",
  titleBarOverlay: false,
  hiddenInMissionControl: false,
  modal: false,
  useContentSize: false,
  paintWhenInitiallyHidden: true,
  type: undefined,
  maxWidth: undefined,
  maxHeight: undefined
});

/**
 * Child window options. The size and position the page asked for in `features` are kept inside
 * `workArea` (the display the user is on); otherwise a roomy default, centred. Window chrome is
 * always the app's. The window starts hidden and is shown once it has painted.
 */
export const popupWindowOptions = ({ features = "", workArea = null } = {}) => {
  const bounds = clampPopupBounds({
    x: featureNumber(features, ["left", "screenX", "x"]),
    y: featureNumber(features, ["top", "screenY", "y"]),
    width: featureNumber(features, ["width"]),
    height: featureNumber(features, ["height"])
  }, workArea);
  return {
    ...POPUP_CHROME,
    ...bounds,
    minWidth: Math.min(POPUP_MIN_SIZE.width, bounds.width),
    minHeight: Math.min(POPUP_MIN_SIZE.height, bounds.height),
    autoHideMenuBar: true,
    show: false
  };
};

/**
 * Counts each service's popups (POP-3). `admit(serviceId)` is asked when a page calls
 * window.open() for a popup and holds an open slot until the window exists; `opened(serviceId)`
 * is called then and returns the function to call once the window has closed.
 */
export function createPopupGate({ limits = POPUP_LIMITS, now = Date.now } = {}) {
  const takeSlot = createRateLimiter({ count: limits.count, windowMs: limits.windowMs, now });
  const open = new Map(); // serviceId -> open popups
  const pending = new Map(); // serviceId -> admit times not yet matched by opened()
  const pendingOf = (serviceId) => {
    const waiting = (pending.get(serviceId) ?? []).filter((at) => now() - at < POPUP_PENDING_MS);
    if (waiting.length) pending.set(serviceId, waiting);
    else pending.delete(serviceId);
    return waiting;
  };
  return {
    admit(serviceId) {
      if (!serviceId) return false;
      if ((open.get(serviceId) ?? 0) + pendingOf(serviceId).length >= limits.maxOpen) return false;
      if (!takeSlot(serviceId)) return false;
      pending.set(serviceId, [...pendingOf(serviceId), now()]);
      return true;
    },
    opened(serviceId) {
      const waiting = pendingOf(serviceId);
      waiting.shift();
      if (waiting.length) pending.set(serviceId, waiting);
      else pending.delete(serviceId);
      open.set(serviceId, (open.get(serviceId) ?? 0) + 1);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const left = (open.get(serviceId) ?? 1) - 1;
        if (left > 0) open.set(serviceId, left);
        else open.delete(serviceId);
      };
    },
    openCount: (serviceId) => open.get(serviceId) ?? 0
  };
}
