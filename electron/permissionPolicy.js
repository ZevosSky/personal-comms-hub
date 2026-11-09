// Web permission rules for service pages (D10). Electron-free; main.js binds them to each session.
import { createRateLimiter } from "./linkPolicy.js";
import { isServiceOwnedUrl, originOf } from "./urlPolicy.js";

// Keys under which remembered decisions are stored per service and origin.
export const PERMISSION_KEYS = Object.freeze({
  camera: "camera",
  microphone: "microphone",
  screen: "display-capture"
});

// Harmless or routed by Comms Hub itself; allowed for any web origin.
const webPermissions = new Set(["notifications", "fullscreen", "clipboard-sanitized-write"]);

/**
 * Keys for a "media" request. Electron reports only camera ("video") and microphone ("audio")
 * here; an empty list is screen capture (getDisplayMedia, or the legacy desktop constraints that
 * bypass the display-media handler), so it gets its own key.
 */
export const mediaRequestKeys = (mediaTypes) => {
  const types = Array.isArray(mediaTypes) ? mediaTypes : [];
  const keys = [];
  if (types.includes("video")) keys.push(PERMISSION_KEYS.camera);
  if (types.includes("audio")) keys.push(PERMISSION_KEYS.microphone);
  return keys.length ? keys : [PERMISSION_KEYS.screen];
};

const checkKeys = (permission, mediaType) => {
  if (permission === "display-capture") return [PERMISSION_KEYS.screen];
  if (permission === "speaker-selection") return [PERMISSION_KEYS.microphone];
  if (permission !== "media") return null;
  if (mediaType === "video") return [PERMISSION_KEYS.camera];
  if (mediaType === "audio") return [PERMISSION_KEYS.microphone];
  return [PERMISSION_KEYS.camera, PERMISSION_KEYS.microphone];
};

/**
 * Decides a permission request from a page.
 * - origin: the requesting frame's origin (null when not http(s)).
 * - service: { url } of the service that owns the page, or null for any other web contents.
 * - ownedAliases: other URLs whose sites count as the service's own (built-in aliases and the
 *   page its home address landed on). The page the view shows now is never one of them.
 * - decisionFor(key) -> "allow" | "block" | null (remembered for this service and origin).
 * Returns { action: "allow" | "deny" | "prompt" | "screen-picker" | "open-external", keys }.
 * "screen-picker" (D9) is granted only once the user picks a source in the picker, which names
 * `foreignOrigin` (null for the service's own site): this step cannot tell getDisplayMedia from
 * legacy desktop constraints, which capture as soon as it is granted.
 */
export const decidePermissionRequest = ({ permission, mediaTypes, origin, service, ownedAliases = [], decisionFor }) => {
  if (permission === "openExternal") return { action: "open-external", keys: [] };
  if (webPermissions.has(permission)) return { action: origin ? "allow" : "deny", keys: [] };
  if (permission !== "media" && permission !== "display-capture") return { action: "deny", keys: [] };
  if (!service || !origin) return { action: "deny", keys: [] };

  const keys = permission === "media" ? mediaRequestKeys(mediaTypes) : [PERMISSION_KEYS.screen];
  const decisions = keys.map((key) => decisionFor(key));
  // A remembered Block always wins, even for the service's own site.
  if (decisions.includes("block")) return { action: "deny", keys };
  const owned = isServiceOwnedUrl({ url: origin, serviceUrl: service.url, aliases: ownedAliases });
  // Never granted by ownership or a remembered Allow, only by a fresh pick.
  if (keys.includes(PERMISSION_KEYS.screen)) return { action: "screen-picker", keys, foreignOrigin: owned ? null : origin };
  if (owned) return { action: "allow", keys };
  if (decisions.every((decision) => decision === "allow")) return { action: "allow", keys };
  return { action: "prompt", keys };
};

/**
 * Permission checks (navigator.permissions, device labels) must agree with requests: never true
 * for something a request would block or would still have to ask about. Screen capture always
 * asks (the picker), so it is never reported as granted.
 */
export const decidePermissionCheck = ({ permission, mediaType, origin, service, ownedAliases = [], decisionFor }) => {
  if (webPermissions.has(permission)) return Boolean(origin);
  const keys = checkKeys(permission, mediaType);
  if (!keys || keys.includes(PERMISSION_KEYS.screen) || !service || !origin) return false;
  const owned = isServiceOwnedUrl({ url: origin, serviceUrl: service.url, aliases: ownedAliases });
  return keys.some((key) => {
    const decision = decisionFor(key);
    return decision === "allow" || (owned && decision !== "block");
  });
};

/** The requesting origin from Electron's request/check details, or null for non-web frames. */
export const requestingOriginOf = (details = {}, fallback = null) =>
  originOf(details.requestingUrl) ?? originOf(details.securityOrigin) ?? originOf(fallback);

const describeKeys = (keys) => {
  const has = (key) => keys.includes(key);
  if (has(PERMISSION_KEYS.screen)) return "share your screen";
  if (has(PERMISSION_KEYS.camera) && has(PERMISSION_KEYS.microphone)) return "use your camera and microphone";
  return has(PERMISSION_KEYS.camera) ? "use your camera" : "use your microphone";
};

const notNowButton = 2;

/**
 * Native prompt options: Allow/Block/Not now with "Remember for this app" checked by default.
 * Enter, Esc and closing the prompt answer "Not now", which is never remembered.
 */
export const permissionPromptOptions = ({ serviceName, origin, keys }) => ({
  type: "question",
  title: "Permission request",
  message: `${serviceName} wants to ${describeKeys(keys)}`,
  detail: `Requested by ${origin}, which is not part of ${serviceName}'s own site.`,
  buttons: ["Allow", "Block", "Not now"],
  defaultId: notNowButton,
  cancelId: notNowButton,
  noLink: true,
  checkboxLabel: "Remember for this app",
  checkboxChecked: true
});

/** Reads showMessageBox's result: only an Allow or Block with the box ticked is remembered. */
export const permissionPromptAnswer = (result) => ({
  allow: result?.response === 0,
  remember: (result?.response === 0 || result?.response === 1) && result?.checkboxChecked === true
});

/**
 * Shows at most one prompt per service, origin and permission set at a time (identical requests
 * share its answer) and a small number per service per minute; extra requests are denied.
 * showPrompt(request) resolves { allow, remember }; remember(serviceId, origin, key, decision).
 */
export function createPermissionPrompter({ showPrompt, remember, log = () => {}, now = Date.now, limit = { count: 3, windowMs: 60000 } }) {
  const pending = new Map();
  const take = createRateLimiter({ ...limit, now });

  const request = ({ serviceId, origin, keys, ...context }) => {
    const id = `${serviceId}\n${origin}\n${keys.join(",")}`;
    if (pending.has(id)) return pending.get(id);
    if (!take(serviceId)) return Promise.resolve(false);
    const answer = Promise.resolve()
      .then(() => showPrompt({ serviceId, origin, keys, ...context }))
      .then((result) => {
        const allow = result?.allow === true;
        if (result?.remember === true) {
          for (const key of keys) {
            // Screen capture needs a fresh pick every time, so an Allow for it is never kept.
            if (!(allow && key === PERMISSION_KEYS.screen)) remember(serviceId, origin, key, allow ? "allow" : "block");
          }
        }
        return allow;
      })
      .catch((error) => {
        log("Failed to ask for a permission.", error);
        return false;
      })
      .finally(() => pending.delete(id));
    pending.set(id, answer);
    return answer;
  };

  return { request };
}
