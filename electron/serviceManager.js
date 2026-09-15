const safeUrl = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export const clampServiceZoom = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(2, Math.max(0.5, number)) : 1;
};

// Electron is injected so lifecycle decisions can be exercised with a deterministic clock.
export function createServiceManager({
  createView,
  onRuntimeChanged = () => {},
  onTitle = () => {},
  onError = () => {},
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  idleTimeoutMs = 600000
}) {
  const entries = new Map();
  const contentsIds = new Map();
  let activeId = null;
  let saver = true;
  let disposed = false;
  let presentation = { host: null, bounds: null, obscured: true, borderRadius: 0 };

  const live = (entry) => entry.view && !entry.view.webContents.isDestroyed();
  const reason = (entry) => {
    if (entry.id === activeId) return "active";
    if (entry.service.keepAliveInBackground) return "pinned";
    if (entry.edited) return "edited";
    if (entry.mediaGranted || entry.playing || (live(entry) && entry.view.webContents.isCurrentlyAudible?.())) return "media";
    if (entry.vetoed) return "beforeunload";
    if (entry.unresponsive) return "unresponsive";
    if (entry.closing) return "closing";
    return null;
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
        error: entry.error
      }];
    }))
  });
  const emit = () => { if (!disposed) onRuntimeChanged(getRuntimeState()); };
  const fail = (entry, error) => {
    entry.error = error instanceof Error ? error.message : String(error);
    onError(entry.id, error);
    emit();
  };
  const clearTimer = (entry) => {
    if (entry.timer !== null) clearTimeoutFn(entry.timer);
    entry.timer = null;
  };
  const detach = (entry) => {
    if (!entry.host) return;
    try {
      if (!entry.host.isDestroyed?.()) entry.host.contentView.removeChildView(entry.view);
    } catch (error) { onError(entry.id, error); }
    entry.host = null;
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
  const schedule = (entry) => {
    clearTimer(entry);
    if (disposed || !saver || !live(entry) || reason(entry)) return;
    const remaining = Math.max(0, idleTimeoutMs - (now() - entry.inactiveSince));
    entry.timer = setTimeoutFn(() => {
      entry.timer = null;
      if (disposed || !saver || !live(entry) || reason(entry)) return;
      rememberUrl(entry, entry.view.webContents.getURL());
      entry.closing = true;
      detach(entry);
      emit();
      try {
        // A beforeunload veto is respected. No preventDefault, confirmation, or force timer.
        entry.view.webContents.close({ waitForBeforeUnload: true });
      } catch (error) {
        entry.closing = false;
        entry.vetoed = true;
        fail(entry, error);
        present();
      }
    }, remaining);
    entry.timer?.unref?.();
  };
  const resetDocumentProtection = (entry) => {
    entry.edited = false;
    entry.mediaGranted = false;
    entry.playing = false;
    entry.vetoed = false;
    entry.unresponsive = false;
  };
  const release = (entry) => {
    clearTimer(entry);
    detach(entry);
    if (!entry.view) return;
    const contents = entry.view.webContents;
    contentsIds.delete(contents.id);
    for (const [event, listener] of entry.listeners) contents.removeListener(event, listener);
    entry.listeners = [];
    entry.view = null;
    entry.closing = false;
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  };
  const ensure = (entry, retry = false) => {
    if (disposed || !entry.service.isEnabled || live(entry) || (entry.error && !retry)) return;
    try {
      entry.view = createView(entry.service);
      const contents = entry.view.webContents;
      contentsIds.set(contents.id, entry.id);
      entry.visited = true;
      entry.loading = true;
      entry.error = null;
      entry.inactiveSince = now();
      resetDocumentProtection(entry);
      const listen = (event, listener) => {
        contents.on(event, listener);
        entry.listeners.push([event, listener]);
      };
      listen("destroyed", () => {
        const wasClosing = entry.closing;
        detach(entry);
        clearTimer(entry);
        contentsIds.delete(contents.id);
        for (const [event, listener] of entry.listeners) contents.removeListener(event, listener);
        entry.listeners = [];
        entry.view = null;
        entry.loading = false;
        entry.closing = false;
        if (!wasClosing) entry.error = "Service page closed unexpectedly. Refresh to reconnect.";
        // An activation during a pending close waits for destruction before recreating.
        if (!disposed && entries.get(entry.id) === entry && wasClosing &&
            (entry.id === activeId || entry.service.keepAliveInBackground || !saver)) ensure(entry);
        present();
        emit();
      });
      listen("will-prevent-unload", () => {
        if (!entry.closing) return;
        entry.closing = false;
        entry.vetoed = true;
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
      listen("page-title-updated", (_event, title) => onTitle(entry.id, title));
      listen("did-start-loading", () => { entry.loading = true; emit(); });
      listen("did-stop-loading", () => { entry.loading = false; applyZoom(entry); emit(); });
      listen("dom-ready", () => applyZoom(entry));
      listen("did-navigate", (_event, url) => {
        rememberUrl(entry, url);
        resetDocumentProtection(entry);
        entry.error = null;
        applyZoom(entry);
        schedule(entry);
        emit();
      });
      listen("did-navigate-in-page", (_event, url, isMainFrame) => {
        if (isMainFrame) rememberUrl(entry, url);
      });
      listen("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame !== false && code !== -3) fail(entry, new Error(description || `Load failed (${code})`));
      });
      listen("render-process-gone", (_event, details) => {
        entry.unresponsive = true;
        clearTimer(entry);
        fail(entry, new Error(`Service renderer stopped (${details?.reason || "unknown"}). Refresh to reconnect.`));
      });
      const url = safeUrl(entry.lastUrl) ? entry.lastUrl : entry.service.url;
      if (!safeUrl(url)) throw new Error("Service URL must use HTTP or HTTPS.");
      Promise.resolve(contents.loadURL(url)).catch((error) => {
        if (entry.view?.webContents === contents && !contents.isDestroyed() && error?.code !== "ERR_ABORTED") fail(entry, error);
      });
      applyZoom(entry);
      schedule(entry);
    } catch (error) {
      if (entry.view) release(entry);
      fail(entry, error);
    }
  };
  return {
    sync(state) {
      if (disposed) return;
      const services = new Map((state.services || []).map((service) => [service.id, service]));
      const previousActive = activeId;
      activeId = services.get(state.ui?.activeServiceId)?.isEnabled ? state.ui.activeServiceId : null;
      saver = state.ui?.memorySaverEnabled !== false;
      for (const [id, entry] of entries) {
        if (!services.has(id)) { release(entry); entries.delete(id); }
      }
      for (const [id, service] of services) {
        let entry = entries.get(id);
        if (!entry) {
          entry = { id, service, view: null, host: null, listeners: [], timer: null,
            lastUrl: service.url, inactiveSince: now(), visited: false, error: null };
          entries.set(id, entry);
        }
        const old = entry.service;
        const previousView = entry.view;
        entry.service = service;
        if (old.url !== service.url || old.sessionPartition !== service.sessionPartition ||
            old.useDefaultSession !== service.useDefaultSession || old.isEnabled !== service.isEnabled) entry.error = null;
        if (old.url !== service.url) entry.lastUrl = service.url;
        if (!service.isEnabled || old.sessionPartition !== service.sessionPartition || old.useDefaultSession !== service.useDefaultSession) release(entry);
        if (previousActive === id && activeId !== id) entry.inactiveSince = now();
        if (service.isEnabled && (id === activeId || service.keepAliveInBackground)) ensure(entry);
        if (live(entry) && entry.view === previousView && !entry.closing && old.url !== service.url) {
          if (safeUrl(service.url)) Promise.resolve(entry.view.webContents.loadURL(service.url)).catch((error) => fail(entry, error));
        }
        schedule(entry);
      }
      if (entries.has(activeId)) applyZoom(entries.get(activeId));
      present();
      emit();
    },
    setPresentation(next) { if (!disposed) { presentation = { ...presentation, ...next }; present(); } },
    refreshActive() {
      const entry = entries.get(activeId);
      if (!entry || disposed || entry.closing) return false;
      if (!live(entry)) ensure(entry, true);
      else {
        entry.error = null;
        entry.view.webContents.reload();
      }
      present();
      emit();
      return true;
    },
    getRuntimeState,
    getServiceIdForContents: (id) => contentsIds.get(id) ?? null,
    markEdited(id) {
      const entry = entries.get(contentsIds.get(id));
      if (!entry) return false;
      entry.edited = true;
      clearTimer(entry);
      emit();
      return true;
    },
    protectMedia(id) {
      const entry = entries.get(contentsIds.get(id));
      if (!entry) return false;
      entry.mediaGranted = true;
      clearTimer(entry);
      emit();
      return true;
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) release(entry);
      entries.clear();
      contentsIds.clear();
    }
  };
}
