// Runs in every frame of a service page (sandboxed, isolated world).
// - Replaces the page's Notification API before any page script runs, so Comms Hub shows the only
//   toast and can forward its click back to the page (D3).
// - Tracks whether editors the user typed in still hold unsent text, and how many camera,
//   microphone and screen tracks are live, so the memory saver can tell (D17).
// No field values or keystrokes leave the page.
const { contextBridge, ipcRenderer } = require("electron");

// Main-world half. Serialized into the page, so it must be self-contained. `host` holds proxies of
// isolated-world functions; the returned object lets this world reach back into the page.
function installPageBridge(host) {
  if (window.__commsNotificationBridgeInstalled) return null;
  window.__commsNotificationBridgeInstalled = true;

  const NativeNotification = window.Notification;
  const permission = () => {
    try {
      return NativeNotification ? NativeNotification.permission : "denied";
    } catch {
      return "denied";
    }
  };
  const text = (value) => (value === undefined || value === null ? "" : String(value));
  const later = (callback) => setTimeout(callback, 0);
  // The on* handlers run as listeners (registered in the constructor), so they see a real
  // event whose target and currentTarget are the notification.
  const eventTypes = ["click", "show", "error", "close"];
  const fire = (target, type) => {
    target.dispatchEvent(new Event(type, { cancelable: type === "click" }));
  };

  // Open notifications by id, oldest first, so clicks can be routed to the page's object.
  const open = new Map();
  const ids = new WeakMap();
  const maxOpen = 100;
  const forget = (notification) => {
    const id = ids.get(notification);
    if (id !== undefined) open.delete(id);
    ids.delete(notification);
    return id;
  };

  class Notification extends EventTarget {
    constructor(title, options = {}) {
      if (arguments.length < 1) {
        throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
      }
      super();
      for (const type of eventTypes) {
        this.addEventListener(type, (event) => {
          const handler = this[`on${type}`];
          if (typeof handler === "function") handler.call(this, event);
        });
      }
      const settings = options && typeof options === "object" ? options : {};
      this.title = String(title);
      this.body = text(settings.body);
      this.tag = text(settings.tag);
      this.icon = text(settings.icon);
      this.image = text(settings.image);
      this.badge = text(settings.badge);
      this.dir = settings.dir === "ltr" || settings.dir === "rtl" ? settings.dir : "auto";
      this.lang = text(settings.lang);
      this.data = settings.data ?? null;
      this.silent = typeof settings.silent === "boolean" ? settings.silent : null;
      this.renotify = settings.renotify === true;
      this.requireInteraction = settings.requireInteraction === true;
      this.timestamp = Number.isFinite(settings.timestamp) ? settings.timestamp : Date.now();
      this.actions = Object.freeze([]);
      this.vibrate = Object.freeze([]);
      this.onclick = null;
      this.onshow = null;
      this.onerror = null;
      this.onclose = null;

      if (permission() !== "granted") {
        later(() => fire(this, "error"));
        return;
      }
      let id = null;
      try {
        id = host.notify({ title: this.title, body: this.body, tag: this.tag, silent: this.silent === true, kind: "page" });
      } catch {
        id = null;
      }
      if (typeof id !== "string") {
        later(() => fire(this, "error"));
        return;
      }
      // A notification with the same tag replaces the earlier one.
      if (this.tag) {
        for (const [otherId, other] of open) {
          if (other.tag === this.tag) {
            open.delete(otherId);
            ids.delete(other);
          }
        }
      }
      ids.set(this, id);
      open.set(id, this);
      while (open.size > maxOpen) forget(open.values().next().value);
      later(() => fire(this, "show"));
    }

    close() {
      const id = forget(this);
      if (id === undefined) return;
      try {
        host.closeNotification(id);
      } catch {}
      later(() => fire(this, "close"));
    }

    static get permission() {
      return permission();
    }

    static requestPermission(callback) {
      let result;
      try {
        result = NativeNotification ? Promise.resolve(NativeNotification.requestPermission()) : Promise.resolve("denied");
      } catch (error) {
        result = Promise.reject(error);
      }
      if (typeof callback === "function") result.then((value) => callback(value), () => {});
      return result;
    }

    static get maxActions() {
      return 0;
    }
  }

  Object.defineProperty(window, "Notification", { value: Notification, writable: true, configurable: true });

  // Notifications shown through a service worker registration are routed the same way. Their
  // clicks belong to the worker, so main only reveals and selects the service for them.
  const Registration = window.ServiceWorkerRegistration;
  if (Registration?.prototype && typeof Registration.prototype.showNotification === "function") {
    Object.defineProperty(Registration.prototype, "showNotification", {
      configurable: true,
      writable: true,
      value: function showNotification(title, options = {}) {
        if (permission() !== "granted") {
          return Promise.reject(new TypeError("No notification permission has been granted for this origin."));
        }
        const settings = options && typeof options === "object" ? options : {};
        try {
          host.notify({ title: String(title), body: text(settings.body), tag: text(settings.tag), silent: settings.silent === true, kind: "worker" });
        } catch {}
        return Promise.resolve();
      }
    });
  }

  // Live capture tracks. Weak references so an abandoned track can still be collected.
  const tracked = new WeakSet();
  const liveTracks = new Set();
  let reported = 0;
  const captureCount = () => {
    let count = 0;
    for (const ref of liveTracks) {
      const track = ref.deref();
      if (track && track.readyState === "live") count += 1;
      else liveTracks.delete(ref);
    }
    return count;
  };
  const report = () => {
    const count = captureCount();
    if (count === reported) return;
    reported = count;
    try {
      host.capture(count);
    } catch {}
  };
  const watchTrack = (track) => {
    if (!track || tracked.has(track)) return;
    tracked.add(track);
    liveTracks.add(new WeakRef(track));
    track.addEventListener("ended", report);
  };
  const watchStream = (stream) => {
    try {
      for (const track of stream.getTracks()) watchTrack(track);
    } catch {}
    report();
    return stream;
  };
  const Track = window.MediaStreamTrack?.prototype;
  if (Track) {
    const { stop, clone } = Track;
    Track.stop = function stopTrack() {
      const result = stop.apply(this, arguments);
      if (tracked.has(this)) report();
      return result;
    };
    Track.clone = function cloneTrack() {
      const copy = clone.apply(this, arguments);
      if (tracked.has(this)) {
        watchTrack(copy);
        report();
      }
      return copy;
    };
  }
  const Stream = window.MediaStream?.prototype;
  if (Stream?.clone) {
    const { clone } = Stream;
    Stream.clone = function cloneStream() {
      const copy = clone.apply(this, arguments);
      try {
        if (this.getTracks().some((track) => tracked.has(track))) watchStream(copy);
      } catch {}
      return copy;
    };
  }

  // Legacy desktop capture (chromeMediaSource) is refused here with a clear error (D9). This is
  // only a courtesy: main grants screen capture solely for a source just picked in the picker.
  // The constraints are copied once, so the browser gets exactly what was checked.
  const clone = window.structuredClone;
  const snapshot = (constraints) => {
    if (!constraints || typeof constraints !== "object") return constraints;
    try {
      return clone(constraints);
    } catch {
      return JSON.parse(JSON.stringify(constraints));
    }
  };
  const requestsDesktop = (constraints) =>
    ["video", "audio"].some((kind) => {
      const value = constraints?.[kind];
      return Boolean(value && typeof value === "object" && (value.mandatory?.chromeMediaSource || value.chromeMediaSource));
    });
  // { constraints } (the copy) when the request may go on, else null.
  const checked = (constraints) => {
    try {
      const copy = snapshot(constraints);
      return requestsDesktop(copy) ? null : { constraints: copy };
    } catch {
      return null;
    }
  };
  const refused = () => new DOMException("Screen capture must use the screen picker.", "NotAllowedError");
  const Devices = window.MediaDevices?.prototype;
  if (Devices && typeof Devices.getUserMedia === "function") {
    const { getUserMedia } = Devices;
    Devices.getUserMedia = function getUserMediaWatched(constraints) {
      const allowed = checked(constraints);
      if (!allowed) return Promise.reject(refused());
      return getUserMedia.call(this, allowed.constraints).then(watchStream);
    };
  }
  if (Devices && typeof Devices.getDisplayMedia === "function") {
    const { getDisplayMedia } = Devices;
    Devices.getDisplayMedia = function getDisplayMediaWatched() {
      return getDisplayMedia.apply(this, arguments).then(watchStream);
    };
  }
  for (const name of ["getUserMedia", "webkitGetUserMedia"]) {
    const legacy = window.Navigator?.prototype?.[name];
    if (typeof legacy !== "function") continue;
    window.Navigator.prototype[name] = function legacyGetUserMedia(constraints, onSuccess, onError) {
      const allowed = checked(constraints);
      if (!allowed) {
        later(() => (typeof onError === "function" ? onError(refused()) : undefined));
        return undefined;
      }
      return legacy.call(this, allowed.constraints, (stream) => {
        watchStream(stream);
        if (typeof onSuccess === "function") onSuccess(stream);
      }, onError);
    };
  }

  return {
    notificationEvent(id, type) {
      const notification = open.get(id);
      if (!notification) return false;
      if (type === "close") forget(notification);
      fire(notification, type === "close" ? "close" : "click");
      return true;
    },
    captureCount
  };
}

const text = (value, max) => String(value ?? "").slice(0, max);
const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(1000, Math.floor(number)) : 0;
};

// Only the top frame and frames of the same origin may raise notifications; main additionally
// checks the frame belongs to the service (security#4).
const mayNotify = () => {
  if (window.top === window) return true;
  try {
    return window.top.location.origin === window.location.origin;
  } catch {
    return false;
  }
};

const idPrefix = Math.random().toString(36).slice(2, 10) || "n";
let notificationSequence = 0;
let page = null;
try {
  page = contextBridge.executeInMainWorld({
    func: installPageBridge,
    args: [{
      notify(payload) {
        if (!mayNotify()) return null;
        notificationSequence += 1;
        const id = `${idPrefix}-${notificationSequence}`;
        ipcRenderer.send("guest:notification", {
          id,
          title: text(payload?.title, 500),
          body: text(payload?.body, 4000),
          tag: text(payload?.tag, 500),
          silent: payload?.silent === true,
          kind: payload?.kind === "worker" ? "worker" : "page"
        });
        return id;
      },
      closeNotification(id) {
        if (typeof id === "string") ipcRenderer.send("guest:notification-close", { id: id.slice(0, 100) });
      },
      capture(live) {
        ipcRenderer.send("guest:capture", count(live));
      }
    }]
  });
} catch {
  page = null;
}

// Main forwards the toast's click (or its dismissal) to the page's Notification object.
ipcRenderer.on("guest:notification-event", (_event, message) => {
  if (typeof message?.id !== "string") return;
  try {
    page?.notificationEvent(message.id, message.type === "close" ? "close" : "click");
  } catch {}
});

// Draft tracking. Only text editors count; search boxes never hold a draft worth keeping.
// Editors may live in a script-created child frame (another realm, see watchFrame below), so
// elements are recognised by nodeType and localName rather than instanceof.
const textInputTypes = new Set(["text", "email", "url", "tel", "password", "number"]);
const searchLabel = /^\s*(?:search|find|filter)\b/i;
const isElement = (node) => node?.nodeType === 1;
const isTextField = (node) => node.localName === "textarea" || node.localName === "input";
const editorFor = (event) => {
  for (const node of event.composedPath()) {
    if (!isElement(node)) continue;
    if (node.localName === "textarea") return node.disabled || node.readOnly ? null : node;
    if (node.localName === "input") {
      return !node.disabled && !node.readOnly && textInputTypes.has(node.type) ? node : null;
    }
    if (node.isContentEditable) {
      let editingHost = node;
      while (editingHost.parentElement?.isContentEditable) editingHost = editingHost.parentElement;
      return editingHost;
    }
  }
  return null;
};
const isSearch = (element) =>
  element.getAttribute("role") === "searchbox" ||
  Boolean(element.closest("[role='search']")) ||
  searchLabel.test(element.getAttribute("aria-label") ?? "") ||
  searchLabel.test(element.getAttribute("placeholder") ?? "");
const hasContent = (element) => {
  if (!element.isConnected) return false;
  if (isTextField(element)) return String(element.value ?? "").trim() !== "";
  return (element.textContent ?? "").replace(/[​-‍⁠]/g, "").trim() !== "";
};

const touched = new Set(); // WeakRef<Element>
const touchedElements = new WeakSet();
let dirtyReported = false;
let recheckTimer = null;
const anyDraft = () => {
  let dirty = false;
  for (const ref of touched) {
    const element = ref.deref();
    if (!element) touched.delete(ref);
    else if (!dirty && hasContent(element)) dirty = true;
  }
  return dirty;
};
const reportDraft = (dirty) => {
  if (dirty === dirtyReported) return;
  dirtyReported = dirty;
  ipcRenderer.send("guest:edited", dirty);
};
const recheck = () => {
  clearTimeout(recheckTimer);
  recheckTimer = null;
  if (touched.size) reportDraft(anyDraft());
};
const onEdit = (event) => {
  if (!event.isTrusted) return;
  const editor = editorFor(event);
  if (!editor || isSearch(editor)) return;
  if (!touchedElements.has(editor)) {
    touchedElements.add(editor);
    touched.add(new WeakRef(editor));
  }
  if (hasContent(editor)) reportDraft(true);
  // Composers are often cleared without an input event (after sending), so look again shortly.
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(recheck, 750);
};
window.addEventListener("input", onEdit, true);
window.addEventListener("change", onEdit, true);
window.addEventListener("focusout", recheck, true);
window.addEventListener("blur", recheck);
document.addEventListener("visibilitychange", recheck);

// Chromium does not run this preload in an iframe that a script creates without a src and fills
// itself (iframe rich-text editors), and its input events never reach this window. So when focus
// moves into a same-origin frame with no preload of its own, its document is watched from here.
// No focus event fires on an iframe element: focus moving into a frame blurs the window it left,
// and each ancestor document then has the frame (or the frame holding it) as its active element.
// `__commsDraftWatch` lives in this preload's isolated world (the page cannot see or set it) and
// marks a window as watched, by its own preload or by another frame's; it goes with its document.
window.__commsDraftWatch = true;
const watchFrame = (element, depth = 0) => {
  if (depth > 10 || !isElement(element) || (element.localName !== "iframe" && element.localName !== "frame")) return;
  let child = null;
  let childDocument = null;
  try {
    child = element.contentWindow;
    childDocument = child?.document; // throws for a cross-origin frame
  } catch {
    return;
  }
  if (!childDocument) return;
  if (child.__commsDraftWatch !== true) {
    child.__commsDraftWatch = true;
    child.addEventListener("input", onEdit, true);
    child.addEventListener("change", onEdit, true);
    child.addEventListener("focusout", recheck, true);
    child.addEventListener("blur", watchFocusedFrames);
  }
  // Focus may have gone straight into a frame nested in this one.
  watchFrame(childDocument.activeElement, depth + 1);
};
// From the topmost same-origin ancestor, follow the focused frames down.
function watchFocusedFrames() {
  let top = window;
  try {
    while (top.parent !== top && top.parent.document) top = top.parent;
  } catch {}
  try {
    watchFrame(top.document.activeElement);
  } catch {}
}
window.addEventListener("blur", watchFocusedFrames);

// Before sleeping a service, main asks every frame that reported something what is still true.
ipcRenderer.on("guest:query-state", (_event, requestId) => {
  const dirty = touched.size ? anyDraft() : false;
  dirtyReported = dirty;
  let captures = 0;
  try {
    captures = count(page?.captureCount());
  } catch {}
  ipcRenderer.send("guest:state", { requestId: String(requestId ?? "").slice(0, 100), dirty, captures });
});
