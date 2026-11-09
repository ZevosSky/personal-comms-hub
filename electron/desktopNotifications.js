// Desktop toasts for service notifications (D3): one toast per page notification, labelled with
// the service, rate-limited per service, and kept referenced until it is clicked so Windows can
// still route a click from the Action Center. Electron-free: the toast class is injected.
import { createRateLimiter } from "./linkPolicy.js";

export const TOAST_RATE_LIMIT = Object.freeze({ count: 5, windowMs: 30000 });
/** Page notifications accepted per service before further ones are ignored outright (flooding). */
export const NOTIFICATION_INTAKE_LIMIT = Object.freeze({ count: 30, windowMs: 60000 });
const maxTrackedToasts = 50;

// Control characters (other than tab/newline) and bidi overrides, which could make a title read as
// another app's, never reach the OS toast.
const clean = (value, max) =>
  String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, max);
// Titles are one line: tabs and line breaks become a space, so nothing can sit apart from the label.
const cleanTitle = (value, max) => clean(String(value ?? "").replace(/[\t\r\n\u0085\u2028\u2029]+/g, " "), max);

/** Validates a `guest:notification` payload from the guest preload. */
export const sanitizeGuestNotification = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = typeof payload.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(payload.id) ? payload.id : null;
  if (!id) return null;
  return {
    id,
    title: cleanTitle(payload.title, 300),
    body: clean(payload.body, 1000),
    tag: clean(payload.tag, 200),
    silent: payload.silent === true,
    kind: payload.kind === "worker" ? "worker" : "page"
  };
};

/** Toasts need the global switch and the service's own desktop alerts on (D3). */
export const shouldShowDesktopToast = ({ ui, service }) =>
  Boolean(ui?.notificationsEnabled && service?.isEnabled && service.notificationSettings?.desktopEnabled !== false);

/**
 * "Discord: Bob" so a toast always says which app raised it (security#4). The label is left off
 * only when the title already is the name or starts with "Name:"; a title that merely begins
 * with the same letters ("X" and "Xbox alert") still gets it.
 */
export const toastTitle = (serviceName, title) => {
  const name = cleanTitle(serviceName, 80) || "Comms Hub";
  const text = cleanTitle(title, 300);
  if (!text) return name;
  const lower = text.toLowerCase();
  const label = name.toLowerCase();
  return lower === label || lower.startsWith(`${label}:`) ? text : `${name}: ${text}`.slice(0, 300);
};

export const overflowBody = (count) => `${count} more notification${count === 1 ? "" : "s"}`;

export function createDesktopNotifier({
  createToast,
  isSupported = () => true,
  onClick = () => {},
  onPageClose = () => {},
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  limit = TOAST_RATE_LIMIT,
  log = () => {}
}) {
  const records = new Set(); // { toast, serviceId, tag, pageKey, target }, oldest first
  const takeSlot = createRateLimiter({ ...limit, now });
  const overflow = new Map(); // serviceId -> { count, serviceName, timer }

  const closeRecord = (record) => {
    records.delete(record);
    try {
      record.toast.close();
    } catch {}
  };

  const present = ({ serviceId, title, body, silent, tag = "", pageKey = null, target = null }) => {
    let toast;
    try {
      toast = createToast({ title, body, silent: silent === true });
    } catch (error) {
      log("Failed to create a desktop notification.", error);
      return false;
    }
    const record = { toast, serviceId, tag, pageKey, target };
    toast.on("click", () => {
      records.delete(record);
      onClick({ serviceId, target });
    });
    toast.on("close", (details) => {
      // A timed-out Windows toast moves to the Action Center and can still be clicked there.
      if (details?.reason === "timedOut") return;
      if (records.delete(record) && target) onPageClose(target);
    });
    toast.on("failed", (_event, error) => {
      records.delete(record);
      log("A desktop notification could not be shown.", error);
    });
    records.add(record);
    while (records.size > maxTrackedToasts) records.delete(records.values().next().value);
    try {
      toast.show();
    } catch (error) {
      records.delete(record);
      log("Failed to show a desktop notification.", error);
      return false;
    }
    return true;
  };

  // Extra notifications in a burst are folded into one "N more notifications" toast.
  const deferOverflow = (serviceId, serviceName) => {
    const pending = overflow.get(serviceId) ?? { count: 0, serviceName, timer: null };
    pending.count += 1;
    pending.serviceName = serviceName;
    overflow.set(serviceId, pending);
    if (pending.timer !== null) return;
    pending.timer = setTimeoutFn(() => {
      overflow.delete(serviceId);
      takeSlot(serviceId);
      present({
        serviceId,
        title: toastTitle(pending.serviceName, ""),
        body: overflowBody(pending.count),
        silent: true
      });
    }, limit.windowMs);
    pending.timer?.unref?.();
  };

  return {
    /**
     * Shows a toast. `pageKey` identifies the page notification (for close()), `target` is passed
     * back to onClick/onPageClose. Resolves "shown" | "throttled" | "unsupported" | "failed".
     */
    notify({ serviceId, serviceName, title, body = "", tag = "", silent = false, pageKey = null, target = null }) {
      if (!isSupported()) return "unsupported";
      if (tag) {
        for (const record of [...records]) {
          if (record.serviceId === serviceId && record.tag === tag) closeRecord(record);
        }
      }
      if (!takeSlot(serviceId)) {
        deferOverflow(serviceId, serviceName);
        return "throttled";
      }
      return present({ serviceId, title: toastTitle(serviceName, title), body, silent, tag, pageKey, target })
        ? "shown"
        : "failed";
    },
    /** The page closed its notification: withdraw the toast. */
    closeFromPage(pageKey) {
      for (const record of [...records]) if (record.pageKey === pageKey) closeRecord(record);
    },
    forgetService(serviceId) {
      for (const record of [...records]) if (record.serviceId === serviceId) records.delete(record);
      const pending = overflow.get(serviceId);
      if (pending?.timer !== null && pending?.timer !== undefined) clearTimeoutFn(pending.timer);
      overflow.delete(serviceId);
    },
    trackedCount: () => records.size,
    dispose() {
      for (const pending of overflow.values()) if (pending.timer !== null) clearTimeoutFn(pending.timer);
      overflow.clear();
      records.clear();
    }
  };
}
