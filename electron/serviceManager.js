import { clampZoomFactor, isHttpUrl } from "./limits.js";

const safeUrl = isHttpUrl;

export const clampServiceZoom = clampZoomFactor;

// Chromium net errors that mean "the network was not reachable"; such loads are retried.
const networkErrorCodes = new Set([
  -7, // TIMED_OUT
  -12, // NETWORK_IO_SUSPENDED (the machine went to sleep mid-load)
  -15, // SOCKET_NOT_CONNECTED
  -21, // NETWORK_CHANGED
  -100, -101, -102, -103, -104, // CONNECTION_CLOSED / RESET / REFUSED / ABORTED / FAILED
  -105, // NAME_NOT_RESOLVED
  -106, // INTERNET_DISCONNECTED
  -109, // ADDRESS_UNREACHABLE
  -111, // TUNNEL_CONNECTION_FAILED
  -118, // CONNECTION_TIMED_OUT
  -120, // SOCKS_CONNECTION_FAILED
  -130, // PROXY_CONNECTION_FAILED
  -137, // NAME_RESOLUTION_FAILED
  -324, // EMPTY_RESPONSE
  -352, // HTTP2_PING_FAILED
  -356 // QUIC_PROTOCOL_ERROR
]);
export const isNetworkErrorCode = (code) => networkErrorCodes.has(Number(code));

/** Delay before each automatic reload of a page that failed for network reasons (last one repeats). */
export const NETWORK_RETRY_DELAYS_MS = Object.freeze([5000, 15000, 30000, 60000, 120000, 300000, 600000]);
/** Delay before each automatic restart of a crashed active or pinned page; more crashes need Refresh. */
export const CRASH_RECOVERY_DELAYS_MS = Object.freeze([2000, 15000, 60000]);
export const CRASH_WINDOW_MS = 30 * 60 * 1000;
/** Capture protection lasts this long after a grant, or after the last capture track ended. */
export const CAPTURE_GRACE_MS = 45000;

const capturesOf = (entry) => {
  let total = 0;
  for (const frame of entry.frames.values()) total += frame.captures;
  return total;
};
const isDirty = (entry) => [...entry.frames.values()].some((frame) => frame.dirty);
const frameCount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(1000, Math.floor(number)) : 0;
};

// Electron is injected so lifecycle decisions can be exercised with a deterministic clock.
// `queryFrames(webContents, frameKeys)` resolves to Map<frameKey, { dirty, captures } | null>
// (null: the frame is gone; a missing key: no answer). It lets the idle timer check whether
// reported drafts and capture tracks still exist before honouring them (D17).
export function createServiceManager({
  createView,
  onRuntimeChanged = () => {},
  onTitle = () => {},
  onError = () => {},
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  idleTimeoutMs = 600000,
  queryFrames = null,
  captureGraceMs = CAPTURE_GRACE_MS,
  networkRetryDelaysMs = NETWORK_RETRY_DELAYS_MS,
  crashRecoveryDelaysMs = CRASH_RECOVERY_DELAYS_MS
}) {
  const entries = new Map();
  const contentsIds = new Map();
  let activeId = null;
  let saver = true;
  let idleMs = idleTimeoutMs;
  let disposed = false;
  let presentation = { host: null, bounds: null, obscured: true, borderRadius: 0 };

  const live = (entry) => entry.view && !entry.view.webContents.isDestroyed();
  const audible = (entry) => {
    try { return live(entry) && entry.view.webContents.isCurrentlyAudible?.() === true; } catch { return false; }
  };
  const capturing = (entry) => capturesOf(entry) > 0 || entry.captureUntil > now();
  const reason = (entry) => {
    if (entry.id === activeId) return "active";
    if (entry.service.keepAliveInBackground) return "pinned";
    if (capturing(entry)) return "capture";
    if (entry.popups > 0) return "popup";
    if (isDirty(entry)) return "edited";
    if (entry.playing || audible(entry)) return "media";
    if (entry.vetoed) return "beforeunload";
    if (entry.unresponsive) return "unresponsive";
    if (entry.closing) return "closing";
    return null;
  };
  // Protections only an event can end. Drafts and live capture are re-checked when the timer
  // fires, and a capture grace period simply delays it.
  const holds = (entry) => entry.id === activeId || entry.service.keepAliveInBackground || entry.popups > 0 ||
    entry.playing || audible(entry) || entry.vetoed || entry.unresponsive || entry.closing;
  const navigationState = (entry) => {
    if (!live(entry)) return { canGoBack: false, canGoForward: false };
    try {
      const contents = entry.view.webContents;
      const history = contents.navigationHistory;
      return {
        canGoBack: Boolean(history?.canGoBack ? history.canGoBack() : contents.canGoBack?.()),
        canGoForward: Boolean(history?.canGoForward ? history.canGoForward() : contents.canGoForward?.())
      };
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  };
  const getRuntimeState = () => ({
    services: Object.fromEntries([...entries].map(([id, entry]) => {
      const protectionReason = reason(entry);
      return [id, {
        status: !entry.service.isEnabled ? "disabled" : entry.error ? "error" : !live(entry)
          ? entry.visited ? "sleeping" : "unloaded"
          : entry.closing ? "closing" : entry.loading ? "loading"
          : id === activeId ? "active" : protectionReason ? "protected" : "idle",
        protectionReason,
        webContentsId: live(entry) ? entry.view.webContents.id : null,
        lastUrl: entry.lastUrl,
        inactiveSince: entry.inactiveSince,
        error: entry.error,
        ...navigationState(entry),
        manuallySlept: entry.manuallySlept,
        retryAt: entry.retryAt
      }];
    }))
  });
  const emit = () => { if (!disposed) onRuntimeChanged(getRuntimeState()); };
  const fail = (entry, error, kind = "load") => {
    entry.error = error instanceof Error ? error.message : String(error);
    entry.failure = kind;
    onError(entry.id, error);
    emit();
  };
  const clearTimer = (entry) => {
    if (entry.timer !== null) clearTimeoutFn(entry.timer);
    entry.timer = null;
  };
  const clearGraceTimer = (entry) => {
    if (entry.graceTimer !== null) clearTimeoutFn(entry.graceTimer);
    entry.graceTimer = null;
  };
  const clearRetry = (entry) => {
    if (entry.retryTimer !== null) clearTimeoutFn(entry.retryTimer);
    entry.retryTimer = null;
    entry.retryAt = null;
  };
  const detach = (entry) => {
    if (!entry.host) return;
    const host = entry.host;
    // A page that had the keyboard hands it to its window (a dialog or picker now covers it, or
    // another app was selected); otherwise neither would have focus and keys would go nowhere.
    let hadFocus = false;
    try { hadFocus = entry.view?.webContents?.isFocused?.() === true; } catch { hadFocus = false; }
    try {
      if (!host.isDestroyed?.()) host.contentView.removeChildView(entry.view);
    } catch (error) { onError(entry.id, error); }
    entry.host = null;
    try {
      if (hadFocus && !host.isDestroyed?.() && host.isVisible?.() !== false) host.webContents?.focus?.();
    } catch (error) { onError(entry.id, error); }
  };
  const applyZoom = (entry) => {
    // Chromium shares origin zoom within a session. Inactive views must never write it.
    if (entry.id !== activeId || !live(entry) || entry.closing) return;
    try { entry.view.webContents.setZoomFactor(clampServiceZoom(entry.service.zoomFactor ?? 1)); }
    catch (error) { onError(entry.id, error); }
  };
  const present = () => {
    const { host, bounds, obscured, borderRadius } = presentation;
    for (const entry of entries.values()) {
      const selected = entry.id === activeId && live(entry) && !entry.closing;
      const visible = selected && host && !host.isDestroyed?.() && bounds && !obscured;
      if (entry.host && (!visible || entry.host !== host)) detach(entry);
      if (!visible) continue;
      try {
        if (!entry.host) {
          host.contentView.addChildView(entry.view);
          entry.host = host;
        }
        entry.view.setBounds(bounds);
        entry.view.setBorderRadius?.(Math.max(0, Number(borderRadius) || 0));
      } catch (error) { onError(entry.id, error); }
    }
  };
  const rememberUrl = (entry, url) => { if (safeUrl(url)) entry.lastUrl = url; };
  // D10: the page the home address lands on through server redirects counts as the service's own
  // site. Called just before loadURL(home); only that navigation (and its redirects) may record it.
  const loadHome = (entry, contents) => {
    entry.landingNav = { armed: true, url: null };
    return contents.loadURL(entry.service.url);
  };
  const sameOrigin = (left, right) => {
    try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
  };
  // Closes the page so its renderer is freed. A beforeunload veto is respected: no
  // preventDefault, confirmation or force timer.
  const putToSleep = (entry, { waitForBeforeUnload = true } = {}) => {
    clearTimer(entry);
    rememberUrl(entry, entry.view.webContents.getURL());
    entry.closing = true;
    detach(entry);
    emit();
    try {
      entry.view.webContents.close({ waitForBeforeUnload });
      return true;
    } catch (error) {
      entry.closing = false;
      entry.vetoed = true;
      entry.manuallySlept = false;
      fail(entry, error);
      present();
      return false;
    }
  };
  // Asks the page whether reported drafts and capture tracks still exist. Frames that are gone
  // are forgotten; frames that do not answer keep what they last reported.
  const verify = (entry) => {
    if (!queryFrames || entry.stateQuery) return;
    const view = entry.view;
    const keys = [...entry.frames.keys()];
    const documentSeq = entry.documentSeq;
    const query = Promise.resolve()
      .then(() => queryFrames(view.webContents, keys))
      .catch((error) => { onError(entry.id, error); return null; });
    entry.stateQuery = query;
    query.then((replies) => {
      if (entry.stateQuery === query) entry.stateQuery = null;
      // A reply from a document that has since navigated away says nothing about the new one.
      if (disposed || entry.view !== view || entry.documentSeq !== documentSeq || !live(entry)) return;
      const capturedBefore = capturesOf(entry) > 0;
      for (const key of keys) {
        if (!(replies instanceof Map) || !replies.has(key)) continue;
        const reply = replies.get(key);
        if (!reply) entry.frames.delete(key);
        else writeFrame(entry, key, { dirty: reply.dirty === true, captures: frameCount(reply.captures) });
      }
      if (capturedBefore && capturesOf(entry) === 0) startCaptureGrace(entry);
      // Still protected: ask again after another idle period, or sooner if the page reports a change.
      entry.confirmedAt = isDirty(entry) || capturesOf(entry) > 0 ? now() : null;
      emit();
      schedule(entry);
    });
  };
  const expire = (entry) => {
    entry.timer = null;
    if (disposed || !saver || !live(entry) || holds(entry)) return;
    if (entry.captureUntil > now()) { schedule(entry); return; }
    if (isDirty(entry) || capturesOf(entry) > 0) { verify(entry); return; }
    putToSleep(entry);
  };
  const schedule = (entry) => {
    clearTimer(entry);
    if (disposed || !saver || !live(entry) || holds(entry)) return;
    const reported = isDirty(entry) || capturesOf(entry) > 0;
    if (reported && !queryFrames) return;
    const since = reported && entry.confirmedAt !== null ? entry.confirmedAt : entry.inactiveSince;
    const remaining = Math.max(0, idleMs - (now() - since), entry.captureUntil - now());
    entry.timer = setTimeoutFn(() => expire(entry), remaining);
    entry.timer?.unref?.();
  };
  const startCaptureGrace = (entry) => {
    entry.captureUntil = Math.max(entry.captureUntil, now() + captureGraceMs);
    clearGraceTimer(entry);
    entry.graceTimer = setTimeoutFn(() => {
      entry.graceTimer = null;
      emit();
      schedule(entry);
    }, Math.max(0, entry.captureUntil - now()));
    entry.graceTimer?.unref?.();
  };
  const writeFrame = (entry, key, { dirty, captures }) => {
    if (!dirty && !captures) entry.frames.delete(key);
    else entry.frames.set(key, { dirty, captures });
  };
  const updateFrame = (contentsId, frameKey, patch) => {
    const entry = entries.get(contentsIds.get(contentsId));
    if (!entry || !live(entry) || frameKey === null || frameKey === undefined) return false;
    const previous = entry.frames.get(frameKey) ?? { dirty: false, captures: 0 };
    const capturedBefore = capturesOf(entry) > 0;
    writeFrame(entry, frameKey, { ...previous, ...patch });
    if (capturedBefore && capturesOf(entry) === 0) startCaptureGrace(entry);
    entry.confirmedAt = null;
    emit();
    schedule(entry);
    return true;
  };
  const resetDocumentProtection = (entry) => {
    entry.documentSeq += 1;
    entry.frames.clear();
    entry.confirmedAt = null;
    entry.captureUntil = 0;
    clearGraceTimer(entry);
    entry.playing = false;
    entry.vetoed = false;
    entry.unresponsive = false;
  };
  const release = (entry) => {
    clearTimer(entry);
    clearGraceTimer(entry);
    clearRetry(entry);
    detach(entry);
    entry.popups = 0;
    if (!entry.view) return;
    const contents = entry.view.webContents;
    contentsIds.delete(contents.id);
    for (const [event, listener] of entry.listeners) contents.removeListener(event, listener);
    entry.listeners = [];
    entry.view = null;
    entry.closing = false;
    entry.loading = false;
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  };
  // Active and pinned pages are kept connected; a page the user put to sleep waits to be selected.
  const wantsLoaded = (entry) => entry.service.isEnabled && (entry.id === activeId ||
    (!entry.manuallySlept && (entry.service.keepAliveInBackground || (!saver && entry.visited))));
  const retry = (entry) => {
    if (disposed || entries.get(entry.id) !== entry || !entry.service.isEnabled || !entry.error) return false;
    clearRetry(entry);
    if (live(entry)) {
      if (entry.closing) return false;
      entry.error = null;
      try { entry.view.webContents.reload(); } catch (error) { fail(entry, error); return false; }
    } else if (wantsLoaded(entry)) {
      ensure(entry, true);
    } else {
      return false;
    }
    present();
    emit();
    return true;
  };
  const scheduleRetry = (entry, delay) => {
    clearRetry(entry);
    if (disposed) return;
    entry.retryAt = now() + delay;
    entry.retryTimer = setTimeoutFn(() => {
      entry.retryTimer = null;
      entry.retryAt = null;
      retry(entry);
    }, delay);
    entry.retryTimer?.unref?.();
  };
  const scheduleNetworkRetry = (entry) => {
    const delay = networkRetryDelaysMs[Math.min(entry.retryAttempt, networkRetryDelaysMs.length - 1)];
    entry.retryAttempt += 1;
    scheduleRetry(entry, delay);
  };
  const ensure = (entry, retryAfterError = false) => {
    if (disposed || !entry.service.isEnabled || live(entry) || (entry.error && !retryAfterError)) return;
    try {
      entry.view = createView(entry.service);
      const contents = entry.view.webContents;
      contentsIds.set(contents.id, entry.id);
      entry.visited = true;
      entry.loading = true;
      entry.error = null;
      entry.manuallySlept = false;
      entry.inactiveSince = now();
      entry.popups = 0;
      resetDocumentProtection(entry);
      const listen = (event, listener) => {
        contents.on(event, listener);
        entry.listeners.push([event, listener]);
      };
      listen("destroyed", () => {
        const wasClosing = entry.closing;
        detach(entry);
        clearTimer(entry);
        clearGraceTimer(entry);
        contentsIds.delete(contents.id);
        for (const [event, listener] of entry.listeners) contents.removeListener(event, listener);
        entry.listeners = [];
        entry.view = null;
        entry.loading = false;
        entry.closing = false;
        entry.popups = 0;
        if (!wasClosing) entry.error = "Service page closed unexpectedly. Refresh to reconnect.";
        // An activation during a pending close waits for destruction before recreating.
        if (!disposed && entries.get(entry.id) === entry && wasClosing && wantsLoaded(entry)) ensure(entry);
        present();
        emit();
      });
      listen("will-prevent-unload", () => {
        if (!entry.closing) return;
        entry.closing = false;
        entry.vetoed = true;
        entry.manuallySlept = false;
        applyZoom(entry);
        present();
        emit();
      });
      listen("unresponsive", () => {
        entry.unresponsive = true;
        // Keep a pending close pending: Electron may still finish it later.
        clearTimer(entry);
        emit();
      });
      listen("responsive", () => { entry.unresponsive = false; schedule(entry); emit(); });
      listen("media-started-playing", () => { entry.playing = true; clearTimer(entry); emit(); });
      listen("media-paused", () => { entry.playing = false; schedule(entry); emit(); });
      listen("audio-state-changed", () => { schedule(entry); emit(); });
      listen("page-title-updated", (_event, title) => onTitle(entry.id, title, contents.id));
      listen("did-start-loading", () => { entry.loading = true; emit(); });
      listen("did-stop-loading", () => { entry.loading = false; applyZoom(entry); emit(); });
      listen("dom-ready", () => applyZoom(entry));
      // The home load starts inside loadURL with no initiating frame. Any other main-frame
      // navigation (links, scripts, history, reloads) ends the tracking without recording.
      listen("did-start-navigation", (details) => {
        if (!details?.isMainFrame) return;
        const tracking = entry.landingNav;
        // The old page's pushState/replaceState does not cancel the home load.
        if (details.isSameDocument && tracking && !tracking.armed) return;
        const home = tracking?.armed && !details.isSameDocument && !details.initiator &&
          sameOrigin(details.url, entry.service.url);
        entry.landingNav = home ? { armed: false, url: details.url } : null;
      });
      listen("did-redirect-navigation", (details) => {
        if (details?.isMainFrame && entry.landingNav && !entry.landingNav.armed) entry.landingNav.url = details.url;
      });
      listen("did-navigate", (_event, url) => {
        const landing = entry.landingNav;
        if (landing && !landing.armed && landing.url === url) {
          entry.landingNav = null;
          if (safeUrl(url)) entry.landing = { home: entry.service.url, url };
        }
        rememberUrl(entry, url);
        resetDocumentProtection(entry);
        entry.error = null;
        entry.failure = null;
        entry.retryAttempt = 0;
        clearRetry(entry);
        applyZoom(entry);
        schedule(entry);
        emit();
      });
      listen("did-navigate-in-page", (_event, url, isMainFrame) => {
        if (!isMainFrame) return;
        rememberUrl(entry, url);
        emit(); // back/forward availability changes with in-page history
      });
      listen("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame === false) return;
        if (entry.landingNav && !entry.landingNav.armed) entry.landingNav = null;
        if (code === -3) return;
        const network = isNetworkErrorCode(code);
        if (network) scheduleNetworkRetry(entry);
        fail(entry, new Error(description || `Load failed (${code})`), network ? "network" : "load");
      });
      listen("render-process-gone", (_event, details) => {
        const time = now();
        entry.crashes = entry.crashes.filter((at) => time - at < CRASH_WINDOW_MS).concat(time);
        const recover = (entry.id === activeId || entry.service.keepAliveInBackground) &&
          entry.crashes.length <= crashRecoveryDelaysMs.length;
        rememberUrl(entry, contents.getURL());
        // The dead page is dropped; recovery creates a fresh one.
        release(entry);
        if (recover) scheduleRetry(entry, crashRecoveryDelaysMs[entry.crashes.length - 1]);
        const why = details?.reason || "unknown";
        fail(entry, new Error(`Service renderer stopped (${why}). ${recover ? "Reconnecting automatically." : "Refresh to reconnect."}`), "crash");
        present();
      });
      const url = safeUrl(entry.lastUrl) ? entry.lastUrl : entry.service.url;
      if (!safeUrl(url)) throw new Error("Service URL must use HTTP or HTTPS.");
      entry.landingNav = null;
      Promise.resolve(url === entry.service.url ? loadHome(entry, contents) : contents.loadURL(url)).catch((error) => {
        // did-fail-load already reported this load (and scheduled any retry).
        if (entry.view?.webContents === contents && !contents.isDestroyed() && error?.code !== "ERR_ABORTED" && !entry.error) fail(entry, error);
      });
      applyZoom(entry);
      schedule(entry);
    } catch (error) {
      if (entry.view) release(entry);
      fail(entry, error);
    }
  };
  const entryForContents = (contentsId) => entries.get(contentsIds.get(contentsId)) ?? null;
  const liveEntry = (id) => {
    const entry = entries.get(id);
    return entry && !disposed && live(entry) && !entry.closing ? entry : null;
  };
  return {
    sync(state) {
      if (disposed) return;
      const services = new Map((state.services || []).map((service) => [service.id, service]));
      const previousActive = activeId;
      activeId = services.get(state.ui?.activeServiceId)?.isEnabled ? state.ui.activeServiceId : null;
      saver = state.ui?.memorySaverEnabled !== false;
      const minutes = Number(state.ui?.memorySaverTimeoutMinutes);
      idleMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : idleTimeoutMs;
      for (const [id, entry] of entries) {
        if (!services.has(id)) { release(entry); entries.delete(id); }
      }
      for (const [id, service] of services) {
        let entry = entries.get(id);
        if (!entry) {
          entry = { id, service, view: null, host: null, listeners: [], timer: null, graceTimer: null,
            retryTimer: null, retryAt: null, retryAttempt: 0, crashes: [], lastUrl: service.url,
            inactiveSince: now(), visited: false, error: null, failure: null, manuallySlept: false,
            frames: new Map(), documentSeq: 0, confirmedAt: null, stateQuery: null, captureUntil: 0, popups: 0,
            landing: null, landingNav: null };
          entries.set(id, entry);
        }
        const old = entry.service;
        const previousView = entry.view;
        entry.service = service;
        if (old.url !== service.url || old.sessionPartition !== service.sessionPartition ||
            old.useDefaultSession !== service.useDefaultSession || old.isEnabled !== service.isEnabled) entry.error = null;
        if (old.url !== service.url) entry.lastUrl = service.url;
        if (!service.isEnabled || old.sessionPartition !== service.sessionPartition || old.useDefaultSession !== service.useDefaultSession) release(entry);
        if (previousActive === id && activeId !== id) {
          entry.inactiveSince = now();
          entry.confirmedAt = null;
        }
        if (previousActive !== id && activeId === id) {
          // Selecting a service wakes it and retries a failed page.
          entry.manuallySlept = false;
          if (entry.error && (!live(entry) || entry.failure === "network")) {
            entry.retryAttempt = 0;
            entry.crashes = [];
            if (live(entry)) retry(entry); else ensure(entry, true);
          }
        }
        if (service.isEnabled && (id === activeId || (service.keepAliveInBackground && !entry.manuallySlept))) ensure(entry);
        if (live(entry) && entry.view === previousView && !entry.closing && old.url !== service.url) {
          if (safeUrl(service.url)) Promise.resolve(loadHome(entry, entry.view.webContents)).catch((error) => fail(entry, error));
        }
        schedule(entry);
      }
      if (entries.has(activeId)) applyZoom(entries.get(activeId));
      present();
      emit();
    },
    setPresentation(next) { if (!disposed) { presentation = { ...presentation, ...next }; present(); } },
    /** Reloads the selected page (`ignoreCache`: a hard reload), or reconnects one that is not loaded. */
    refreshActive({ ignoreCache = false } = {}) {
      const entry = entries.get(activeId);
      if (!entry || disposed || entry.closing) return false;
      clearRetry(entry);
      entry.retryAttempt = 0;
      entry.crashes = [];
      if (!live(entry)) ensure(entry, true);
      else {
        entry.error = null;
        if (ignoreCache) entry.view.webContents.reloadIgnoringCache();
        else entry.view.webContents.reload();
      }
      present();
      emit();
      return true;
    },
    /**
     * "Sleep now" (D16): closes any loaded app except the selected one; pinned apps stay asleep until
     * selected. Refused while the app has popups open (closing it would destroy them without asking)
     * unless `force`.
     */
    sleep(id, { force = false } = {}) {
      const entry = liveEntry(id);
      if (!entry || id === activeId || (entry.popups > 0 && !force)) return false;
      clearRetry(entry);
      entry.error = null;
      entry.failure = null;
      entry.manuallySlept = true;
      // A hung page cannot answer beforeunload, so it is closed without asking.
      return putToSleep(entry, { waitForBeforeUnload: !entry.unresponsive });
    },
    /** Reloads pages that failed for network reasons now (resume, unlock, back online). */
    retryFailed() {
      let retried = 0;
      for (const entry of entries.values()) {
        if (!entry.error || entry.failure !== "network") continue;
        entry.retryAttempt = 0;
        if (retry(entry)) retried += 1;
      }
      return retried;
    },
    goHome(id = activeId) {
      const entry = entries.get(id);
      if (!entry || disposed || !entry.service.isEnabled || entry.closing || !safeUrl(entry.service.url)) return false;
      clearRetry(entry);
      entry.lastUrl = entry.service.url;
      entry.error = null;
      if (live(entry)) {
        const contents = entry.view.webContents;
        Promise.resolve(loadHome(entry, contents)).catch((error) => {
          if (entry.view?.webContents === contents && error?.code !== "ERR_ABORTED") fail(entry, error);
        });
      } else if (wantsLoaded(entry)) {
        ensure(entry, true);
      }
      present();
      emit();
      return true;
    },
    goBack(id = activeId) {
      const entry = liveEntry(id);
      if (!entry || !navigationState(entry).canGoBack) return false;
      const contents = entry.view.webContents;
      if (contents.navigationHistory?.goBack) contents.navigationHistory.goBack();
      else contents.goBack();
      return true;
    },
    goForward(id = activeId) {
      const entry = liveEntry(id);
      if (!entry || !navigationState(entry).canGoForward) return false;
      const contents = entry.view.webContents;
      if (contents.navigationHistory?.goForward) contents.navigationHistory.goForward();
      else contents.goForward();
      return true;
    },
    getRuntimeState,
    getServiceIdForContents: (id) => contentsIds.get(id) ?? null,
    /** Where the service's home address landed after server redirects only (D10), or null. */
    getLandingUrl(contentsId) {
      const entry = entryForContents(contentsId);
      return entry?.landing && entry.landing.home === entry.service.url ? entry.landing.url : null;
    },
    /** The live page of a service (default: the selected one), or null. */
    getContents(id = activeId) { return liveEntry(id)?.view.webContents ?? null; },
    /** `{ [serviceId]: webContents }` for every loaded page, e.g. for memory metrics. */
    getLiveContents() {
      const result = {};
      for (const [id, entry] of entries) if (liveEntry(id)) result[id] = entry.view.webContents;
      return result;
    },
    /** A frame of the page reports whether an editor it touched still holds unsent text. */
    setEdited(contentsId, frameKey, dirty) { return updateFrame(contentsId, frameKey, { dirty: dirty === true }); },
    /** A frame of the page reports how many camera/microphone/screen tracks it has live. */
    setCapture(contentsId, frameKey, liveTracks) { return updateFrame(contentsId, frameKey, { captures: frameCount(liveTracks) }); },
    /** Capture is starting (a granted permission or a picked screen): protect it for a grace period. */
    protectMedia(contentsId) {
      const entry = entryForContents(contentsId);
      if (!entry || !live(entry)) return false;
      startCaptureGrace(entry);
      emit();
      schedule(entry);
      return true;
    },
    /** An open popup protects its opener; call the returned function when the popup closes. */
    protectPopup(contentsId) {
      const entry = entryForContents(contentsId);
      if (!entry || !live(entry)) return () => {};
      const view = entry.view;
      entry.popups += 1;
      clearTimer(entry);
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (disposed || entry.view !== view) return;
        entry.popups = Math.max(0, entry.popups - 1);
        emit();
        schedule(entry);
      };
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) release(entry);
      entries.clear();
      contentsIds.clear();
    }
  };
}
