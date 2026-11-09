// Screen-share broker (D9). A page asking to capture the screen is shown a picker in the window
// hosting that service (in-app when its renderer offers one, else a native dialog), and capture
// is granted only for the source the user picks there. Nothing is ever auto-selected.
// Electron-free: capture, windows and dialogs are injected.
import { createRateLimiter } from "./linkPolicy.js";

export const SCREEN_SHARE_TIMEOUT_MS = 120000;
// How long a pick waits for the display-media request it granted (normally a few milliseconds).
export const SCREEN_SHARE_APPROVAL_MS = 5000;
export const SCREEN_SHARE_THUMBNAIL_SIZE = Object.freeze({ width: 320, height: 180 });
const thumbnailJpegQuality = 70;
const appIconSize = 32;
const nativePickerWindowLimit = 12;
const sourceNameMaxLength = 200;

// Electron supports system-audio loopback only on Windows.
export const supportsLoopbackAudio = (platform) => platform === "win32";

const isScreenSource = (source) => String(source?.id ?? "").startsWith("screen:");

const imageDataUrl = (image, encode) => {
  try {
    return image && !image.isEmpty() ? encode(image) : null;
  } catch {
    return null;
  }
};

/** The renderer-facing description of a desktopCapturer source (bridge contract). */
export const toPickerSource = (source) => ({
  id: String(source.id),
  name: String(source.name ?? "").slice(0, sourceNameMaxLength),
  kind: isScreenSource(source) ? "screen" : "window",
  // Null when the OS gives no thumbnail (e.g. a minimized window).
  thumbnailDataUrl: imageDataUrl(
    source.thumbnail,
    (image) => `data:image/jpeg;base64,${image.toJPEG(thumbnailJpegQuality).toString("base64")}`
  ),
  appIconDataUrl: imageDataUrl(source.appIcon, (image) =>
    (image.getSize().width > appIconSize
      ? image.resize({ width: appIconSize, height: appIconSize, quality: "good" })
      : image
    ).toDataURL()
  )
});

// What the display-media callback gets to deny a request. Electron 44 throws on `{}` when video
// was requested; `null` rejects the page's getDisplayMedia (Chromium reports it as AbortError).
export const DENY_SCREEN_SHARE = null;

/** Maps the user's choice to the display-media callback argument. Unknown or null ids deny. */
export const resolveScreenShareChoice = ({ sources = [], sourceId, shareAudio, audioRequested, platform }) => {
  const source = typeof sourceId === "string" ? sources.find((item) => item.id === sourceId) : null;
  if (!source) return DENY_SCREEN_SHARE;
  return shareAudio === true && audioRequested && supportsLoopbackAudio(platform)
    ? { video: source, audio: "loopback" }
    : { video: source };
};

/** Same wording as the camera/microphone prompt for a page outside the service's own site. */
export const foreignOriginNotice = (serviceName, origin) =>
  `Requested by ${origin}, which is not part of ${serviceName}'s own site.`;

const label = (text) => {
  const value = String(text ?? "").trim() || "Untitled";
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
};

/** Native fallback: one button per screen and per window (capped), then Cancel. */
export const nativePickerModel = ({ serviceName, sources, audioRequested, foreignOrigin = null }) => {
  const screens = sources.filter(isScreenSource);
  const windows = sources.filter((source) => !isScreenSource(source)).slice(0, nativePickerWindowLimit);
  const choices = [...screens, ...windows];
  const buttons = [
    ...choices.map((source) =>
      isScreenSource(source)
        ? screens.length > 1 ? `Screen: ${label(source.name)}` : "Entire screen"
        : `Window: ${label(source.name)}`
    ),
    "Cancel"
  ];
  const choose = "Choose a screen or window to share.";
  return {
    choices,
    options: {
      type: "question",
      title: "Share your screen",
      message: `${serviceName} wants to share your screen`,
      detail: foreignOrigin ? `${foreignOriginNotice(serviceName, foreignOrigin)}\n${choose}` : choose,
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      ...(audioRequested ? { checkboxLabel: "Also share system audio", checkboxChecked: false } : {})
    }
  };
};

/**
 * Two steps, because Electron's permission step cannot tell getDisplayMedia from legacy desktop
 * constraints, and the latter capture as soon as that permission is granted:
 * - approve() runs from the permission handler: it shows the picker and resolves true once the
 *   user picks a source, which is kept briefly for that page;
 * - handleRequest() runs from the display-media handler: it uses that pick once, and denies
 *   when there is none (or it is stale, or from another origin).
 * Injected:
 * - describeGuest(guestId) -> { serviceId, serviceName } | null
 * - getSources() -> desktopCapturer sources (already filtered)
 * - prepareHost(serviceId) -> { id, hasPicker, send(channel, payload), window } | null; reveals it
 * - showNativePicker({ host, options, signal }) -> { response, checkboxChecked }
 * - watchGuest(guestId, onGone) -> unwatch; onGone on main-frame navigation or destruction
 * - onPicked(guestId) once a source is picked; onChange() when in-app pickers open or close
 */
export function createScreenShareBroker({
  describeGuest,
  getSources,
  prepareHost,
  showNativePicker,
  watchGuest = () => () => {},
  onPicked = () => {},
  onChange = () => {},
  log = () => {},
  platform = process.platform,
  timeoutMs = SCREEN_SHARE_TIMEOUT_MS,
  approvalMs = SCREEN_SHARE_APPROVAL_MS,
  rateLimit = { count: 5, windowMs: 60000 },
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  const byGuest = new Map();
  // Requests in arrival order, so a window's waiting in-app requests are shown first-in first-out.
  const byId = new Map();
  // guestId -> { origin, sources, sourceId, shareAudio, expires }: a pick not used yet.
  const approvals = new Map();
  const take = createRateLimiter({ ...rateLimit, now });
  let nextId = 1;
  let disposed = false;

  const notifyHost = (request, channel, payload) => {
    try {
      request.host?.send(channel, payload);
    } catch (error) {
      log("Failed to reach the screen-share picker.", error);
    }
  };

  // One in-app picker per window: the request it shows now; others for that window wait.
  const isShown = (request) => request.inApp && !request.queued;
  const shownFor = (hostId) => [...byId.values()].find((request) => isShown(request) && request.host?.id === hostId);

  const show = (request) => {
    request.queued = false;
    // The full time to answer starts when the picker appears.
    clearTimeoutFn(request.timer);
    request.timer = setTimeoutFn(() => settle(request, null, "timeout"), timeoutMs);
    notifyHost(request, "screen-share:request", request.payload);
    onChange();
  };

  const showNext = (hostId) => {
    if (disposed) return;
    const next = [...byId.values()].find((request) => request.inApp && request.queued && request.host?.id === hostId);
    if (next) show(next);
  };

  // Answers approve() exactly once; a choice is kept for the display-media request. `cancelReason`
  // tells an open in-app picker why it must close; it is null when the host itself answered.
  const settle = (request, choice, cancelReason = null) => {
    if (request.settled) return false;
    request.settled = true;
    clearTimeoutFn(request.timer);
    request.unwatch?.();
    request.abort?.abort();
    byId.delete(request.id);
    if (byGuest.get(request.guestId) === request) byGuest.delete(request.guestId);
    if (choice) {
      approvals.set(request.guestId, {
        origin: request.origin,
        sources: request.sources,
        sourceId: choice.sourceId,
        shareAudio: choice.shareAudio,
        expires: now() + approvalMs
      });
    }
    request.resolve(Boolean(choice));
    if (request.inApp) {
      if (!request.queued) {
        if (cancelReason) notifyHost(request, "screen-share:cancelled", { requestId: request.id, reason: cancelReason });
        showNext(request.host.id);
      }
      onChange();
    }
    return true;
  };

  const finish = (request, sourceId, shareAudio) => {
    const source = typeof sourceId === "string" ? request.sources.find((item) => item.id === sourceId) : null;
    const choice = source ? { sourceId: source.id, shareAudio: shareAudio === true } : null;
    if (settle(request, choice) && choice) onPicked(request.guestId);
  };

  const present = async (request, service) => {
    const sources = await getSources();
    if (request.settled) return;
    request.sources = Array.isArray(sources) ? sources : [];
    const host = await prepareHost(service.serviceId);
    if (request.settled) return;
    if (!host) {
      settle(request, null);
      return;
    }
    request.host = host;

    if (host.hasPicker) {
      const busy = Boolean(shownFor(host.id));
      request.inApp = true;
      request.payload = {
        requestId: request.id,
        serviceId: service.serviceId,
        serviceName: service.serviceName,
        foreignOrigin: request.foreignOrigin,
        audioRequested: request.audioOffered,
        sources: request.sources.map(toPickerSource)
      };
      if (busy) request.queued = true;
      else show(request);
      return;
    }

    const model = nativePickerModel({
      serviceName: service.serviceName,
      sources: request.sources,
      audioRequested: request.audioOffered,
      foreignOrigin: request.foreignOrigin
    });
    request.abort = new AbortController();
    const result = await showNativePicker({ host, options: model.options, signal: request.abort.signal });
    if (request.settled) return;
    finish(request, model.choices[result?.response]?.id ?? null, result?.checkboxChecked === true);
  };

  /**
   * Asks the user to pick a source for a page that wants to capture the screen. `origin` is the
   * requesting frame's; `foreignOrigin` is set when that is not the service's own site, and the
   * picker names it. Resolves true once a source is picked.
   */
  const approve = ({ guestId, origin = null, foreignOrigin = null }) => {
    approvals.delete(guestId);
    let service = null;
    try {
      service = disposed ? null : describeGuest(guestId);
    } catch (error) {
      log("Failed to identify the app asking to share the screen.", error);
    }
    if (!service || !take(guestId)) return Promise.resolve(false);
    const previous = byGuest.get(guestId);
    if (previous) settle(previous, null, "superseded");

    let resolve;
    const answered = new Promise((done) => {
      resolve = done;
    });
    const request = {
      id: `share-${nextId++}`,
      guestId,
      origin,
      foreignOrigin: typeof foreignOrigin === "string" && foreignOrigin ? foreignOrigin : null,
      resolve,
      settled: false,
      inApp: false,
      queued: false,
      host: null,
      sources: [],
      // This step cannot tell whether the page asked for audio, so system audio is offered
      // wherever loopback works; handleRequest adds it only when the page asked for it.
      audioOffered: supportsLoopbackAudio(platform)
    };
    byGuest.set(guestId, request);
    byId.set(request.id, request);
    request.timer = setTimeoutFn(() => settle(request, null, "timeout"), timeoutMs);
    const unwatch = watchGuest(guestId, () => settle(request, null, "navigated"));
    if (request.settled) unwatch();
    else request.unwatch = unwatch;

    present(request, service).catch((error) => {
      log("Screen-share request failed.", error);
      settle(request, null, "error");
    });
    return answered;
  };

  /** The display-media request: shares the source just picked for this page, once; else denies. */
  const handleRequest = ({ guestId, origin = null, videoRequested, audioRequested }, callback) => {
    const approval = approvals.get(guestId);
    approvals.delete(guestId);
    const fresh = Boolean(approval && !disposed && videoRequested && approval.origin === origin && now() <= approval.expires);
    const streams = fresh ? resolveScreenShareChoice({ ...approval, audioRequested, platform }) : DENY_SCREEN_SHARE;
    try {
      callback(streams);
    } catch (error) {
      log("Failed to answer a screen-share request.", error);
    }
  };

  /** The in-app picker's answer. Only the window showing it may answer. */
  const respond = (senderId, response) => {
    const request = byId.get(response?.requestId);
    if (!request || !isShown(request) || request.host?.id !== senderId) return false;
    finish(request, typeof response.sourceId === "string" ? response.sourceId : null, response.shareAudio === true);
    return true;
  };

  return {
    approve,
    handleRequest,
    respond,
    /** True while an in-app picker is shown in this host, so its service view stays hidden. */
    isPickerOpen: (hostId) => Boolean(shownFor(hostId)),
    cancelForHost: (hostId) => {
      // Waiting requests first, so none is shown to a window that is going away.
      const requests = [...byId.values()].filter((request) => request.host?.id === hostId);
      for (const request of [...requests.filter((item) => item.queued), ...requests.filter((item) => !item.queued)]) {
        settle(request, null, "host-closed");
      }
    },
    pendingCount: () => byId.size,
    dispose: () => {
      disposed = true;
      approvals.clear();
      for (const request of [...byId.values()]) settle(request, null);
    }
  };
}
