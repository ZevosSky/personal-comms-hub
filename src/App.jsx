import { startTransition, useEffect, useMemo, useRef, useState } from "react";

const defaultForm = {
  id: null,
  name: "",
  url: "",
  iconSource: "",
  iconKey: "globe",
  isEnabled: true
};

const parseBadgeCount = (title) => {
  if (!title) {
    return 0;
  }

  const match = title.match(/\((\d+)\)|\[(\d+)\]|^(\d+)\s/);
  const count = Number(match?.[1] ?? match?.[2] ?? match?.[3] ?? 0);
  return Number.isFinite(count) ? count : 0;
};

const sanitizeUrl = (url) => {
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
};

const getInitials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

const getWorkspaceLabel = (service) => {
  if (!service) {
    return "";
  }

  if (service.id === "teams") {
    return "Microsoft Teams workspace";
  }

  return `${getInitials(service.name)} workspace`;
};

const getMemoryStateLabel = (service, memorySaverEnabled) => {
  if (!service) {
    return "Idle";
  }

  if (service.keepAliveInBackground) {
    return memorySaverEnabled ? "Keep alive" : "Pinned warm";
  }

  return memorySaverEnabled ? "Sleeps idle" : "Warm tabs";
};

const ServiceFormModal = ({
  form,
  onChange,
  onClose,
  onSave,
  onUploadIcon,
  iconLibrary,
  canDelete,
  onDelete
}) => (
  <div className="modal-backdrop">
    <div className="modal">
      <div className="modal-header">
        <div>
          <p className="eyebrow">Service setup</p>
          <h2>{form.id ? "Edit app" : "Add app"}</h2>
        </div>
        <button className="ghost-button" onClick={onClose} type="button">
          Close
        </button>
      </div>

      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={form.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Slack, Outlook, Telegram..."
        />
      </label>

      <label className="field">
        <span>URL</span>
        <input
          type="url"
          value={form.url}
          onChange={(event) => onChange({ url: event.target.value })}
          placeholder="https://..."
        />
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={form.isEnabled}
          onChange={(event) => onChange({ isEnabled: event.target.checked })}
        />
        <span>Show this app in the sidebar</span>
      </label>

      <div className="field">
        <span>Choose icon</span>
        <div className="icon-grid">
          {iconLibrary.map((icon) => (
            <button
              key={icon.key}
              type="button"
              className={`icon-option ${form.iconSource === icon.iconSource ? "selected" : ""}`}
              onClick={() => onChange({ iconSource: icon.iconSource, iconKey: icon.key })}
            >
              <img src={icon.iconSource} alt={icon.label} />
              <span>{icon.label}</span>
            </button>
          ))}
        </div>
        <button className="secondary-button" onClick={onUploadIcon} type="button">
          Upload custom icon
        </button>
      </div>

      <div className="modal-actions">
        {canDelete ? (
          <button className="danger-button" onClick={onDelete} type="button">
            Remove app
          </button>
        ) : (
          <span className="modal-hint">Built-in apps can be edited but not removed.</span>
        )}
        <button className="primary-button" onClick={onSave} type="button">
          Save app
        </button>
      </div>
    </div>
  </div>
);

const EmptyState = ({ title = "Choose a service from the left rail", body }) => (
  <div className="empty-state">
    <p className="eyebrow">No app selected</p>
    <h2>{title}</h2>
    <p>{body || "Built-in services keep their own login sessions and can be reopened anytime."}</p>
  </div>
);

const rendererMode = (() => {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "dock" || mode === "bubble" || mode === "trigger" ? mode : "full";
})();

const rightAnchoredCorners = new Set(["top-right", "bottom-right"]);
const dockHeightRange = {
  min: 280,
  max: 720
};

function App() {
  const [appState, setAppState] = useState(null);
  const [modalForm, setModalForm] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [didAutoCheckUpdates, setDidAutoCheckUpdates] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Loading services...");
  const [badgeCounts, setBadgeCounts] = useState({});
  const [loadedServiceIds, setLoadedServiceIds] = useState([]);
  const [guestPreloadPath, setGuestPreloadPath] = useState("");
  const notifiedCountsRef = useRef({});
  const webviewRefs = useRef({});

  useEffect(() => {
    let unsubscribe = null;

    Promise.all([window.commsApp.getState(), window.commsApp.getGuestPreloadPath()]).then(
      ([state, preloadPath]) => {
        startTransition(() => {
          setAppState(state);
          setGuestPreloadPath(preloadPath);
          setLoadedServiceIds(state.ui.activeServiceId ? [state.ui.activeServiceId] : []);
          setStatusMessage("Ready");
        });
      }
    );

    unsubscribe = window.commsApp.onStateUpdated((state) => {
      startTransition(() => setAppState(state));
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.windowMode = rendererMode;
    document.body.dataset.windowMode = rendererMode;

    return () => {
      delete document.documentElement.dataset.windowMode;
      delete document.body.dataset.windowMode;
    };
  }, []);

  useEffect(() => {
    if (!appState || didAutoCheckUpdates) {
      return;
    }

    setIsCheckingUpdates(true);
    window.commsApp
      .checkForUpdates()
      .then((result) => {
        startTransition(() => setUpdateInfo(result));
      })
      .finally(() => {
        setDidAutoCheckUpdates(true);
        setIsCheckingUpdates(false);
      });
  }, [appState, didAutoCheckUpdates]);

  const services = useMemo(
    () => appState?.services?.filter((service) => service.isEnabled) ?? [],
    [appState]
  );
  const activeServiceId =
    appState?.ui?.activeServiceId ?? services.find((service) => service.isEnabled)?.id ?? null;
  const activeService = services.find((service) => service.id === activeServiceId) ?? null;
  const activeIndex = services.findIndex((service) => service.id === activeServiceId);
  const isDockMode = rendererMode === "dock";
  const isBubbleMode = rendererMode === "bubble";
  const isTriggerMode = rendererMode === "trigger";
  const dockCorner = appState?.ui?.dockCorner ?? "bottom-left";
  const dockExpanded = appState?.ui?.dockExpanded ?? true;
  const isRightAnchored = rightAnchoredCorners.has(dockCorner);
  const notificationCounts = useMemo(() => {
    const counts = {};
    const lastSeenByService = appState?.ui?.notificationLastSeenByService ?? {};

    for (const entry of appState?.notificationHistory ?? []) {
      if (!entry?.serviceId) {
        continue;
      }

      const lastSeenAt = lastSeenByService[entry.serviceId];
      if (lastSeenAt && new Date(entry.createdAt).getTime() <= new Date(lastSeenAt).getTime()) {
        continue;
      }

      counts[entry.serviceId] = (counts[entry.serviceId] ?? 0) + 1;
    }

    return counts;
  }, [appState?.notificationHistory, appState?.ui?.notificationLastSeenByService]);
  const keepAliveServiceIds = useMemo(
    () => services.filter((service) => service.keepAliveInBackground).map((service) => service.id),
    [services]
  );
  const renderedServices = useMemo(() => {
    if (!activeService || !guestPreloadPath) {
      return [];
    }

    if (appState?.ui?.memorySaverEnabled) {
      const wantedIds = new Set([activeService.id, ...keepAliveServiceIds]);
      return services.filter((service) => wantedIds.has(service.id));
    }

    return services.filter((service) => loadedServiceIds.includes(service.id));
  }, [
    activeService,
    appState?.ui?.memorySaverEnabled,
    guestPreloadPath,
    keepAliveServiceIds,
    loadedServiceIds,
    services
  ]);

  useEffect(() => {
    if (!activeServiceId) {
      return;
    }

    setLoadedServiceIds((current) => (current.includes(activeServiceId) ? current : [...current, activeServiceId]));
  }, [activeServiceId]);

  useEffect(() => {
    if (!keepAliveServiceIds.length) {
      return;
    }

    setLoadedServiceIds((current) => {
      const next = new Set(current);
      keepAliveServiceIds.forEach((id) => next.add(id));
      return [...next];
    });
  }, [keepAliveServiceIds]);

  useEffect(() => {
    renderedServices.forEach((service) => {
      const webview = webviewRefs.current[service.id];
      if (!webview || webview.dataset.bound === "true") {
        return;
      }

      const onTitle = (event) => {
        handleTitleUpdate(service, event.title);
      };

      const onFailLoad = () => {
        setStatusMessage(`Unable to load ${service.name}. Check the URL or site access.`);
      };

      const onIpcMessage = (event) => {
        if (event.channel !== "comms-app-notification") {
          return;
        }

        handleCapturedNotification(service, event.args?.[0] ?? {});
      };

      webview.addEventListener("page-title-updated", onTitle);
      webview.addEventListener("did-fail-load", onFailLoad);
      webview.addEventListener("ipc-message", onIpcMessage);
      webview.dataset.bound = "true";
      webview.__cleanup = () => {
        webview.removeEventListener("page-title-updated", onTitle);
        webview.removeEventListener("did-fail-load", onFailLoad);
        webview.removeEventListener("ipc-message", onIpcMessage);
        delete webview.dataset.bound;
      };
    });

    return () => {
      Object.values(webviewRefs.current).forEach((webview) => webview?.__cleanup?.());
    };
  }, [renderedServices, activeServiceId]);

  const openCreateModal = () => {
    setModalForm({
      ...defaultForm,
      iconSource: appState?.iconLibrary?.find((icon) => icon.key === "globe")?.iconSource ?? ""
    });
  };

  const openEditModal = (service) => {
    setModalForm({
      id: service.id,
      name: service.name,
      url: service.url,
      iconSource: service.iconSource,
      iconKey: service.iconKey ?? "globe",
      isEnabled: service.isEnabled
    });
  };

  const updateForm = (updates) => {
    setModalForm((current) => ({ ...current, ...updates }));
  };

  const handleSave = async () => {
    const normalizedUrl = sanitizeUrl(modalForm.url);
    if (!modalForm.name.trim() || !normalizedUrl) {
      setStatusMessage("Name and a valid https:// URL are required.");
      return;
    }

    const existing = appState.services.find((service) => service.id === modalForm.id);
    const nextState = await window.commsApp.saveService({
      ...existing,
      ...modalForm,
      url: normalizedUrl
    });
    setAppState(nextState);
    setModalForm(null);
    setStatusMessage(`Saved ${modalForm.name}.`);
  };

  const handleDelete = async () => {
    if (!modalForm?.id) {
      return;
    }

    const nextState = await window.commsApp.removeService(modalForm.id);
    setAppState(nextState);
    setModalForm(null);
    setStatusMessage("Removed app.");
  };

  const handleRemoveService = async (serviceId) => {
    if (!serviceId) {
      return;
    }

    const target = appState.services.find((service) => service.id === serviceId);
    if (!target || target.isBuiltIn) {
      return;
    }

    const nextState = await window.commsApp.removeService(serviceId);
    setAppState(nextState);
    setStatusMessage(`Removed ${target.name}.`);
  };

  const moveService = async (serviceId, direction) => {
    const ids = appState.services.map((service) => service.id);
    const currentIndex = ids.indexOf(serviceId);
    const targetIndex = currentIndex + direction;

    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= ids.length) {
      return;
    }

    const nextIds = [...ids];
    [nextIds[currentIndex], nextIds[targetIndex]] = [nextIds[targetIndex], nextIds[currentIndex]];

    const nextState = await window.commsApp.reorderServices(nextIds);
    setAppState(nextState);
  };

  const selectService = async (serviceId) => {
    const nextState = await window.commsApp.setActiveService(serviceId);
    const finalState = isDockMode && !dockExpanded
      ? await window.commsApp.setDockExpanded(true)
      : nextState;
    setAppState(finalState);
    setStatusMessage(`Switched to ${finalState.services.find((service) => service.id === serviceId)?.name ?? "service"}.`);
  };

  const toggleNotifications = async () => {
    const nextState = await window.commsApp.setNotificationsEnabled(!appState.ui.notificationsEnabled);
    setAppState(nextState);
  };

  const toggleMemorySaver = async () => {
    const nextState = await window.commsApp.setMemorySaverEnabled(!appState.ui.memorySaverEnabled);
    setAppState(nextState);
    if (!appState.ui.memorySaverEnabled) {
      setLoadedServiceIds(services.map((service) => service.id));
    } else if (activeServiceId) {
      setLoadedServiceIds([activeServiceId]);
    }
  };

  const toggleSidebarCollapsed = async () => {
    const nextState = await window.commsApp.setSidebarCollapsed(!appState.ui.sidebarCollapsed);
    setAppState(nextState);
  };

  const setWindowMode = async (mode) => {
    const nextState = await window.commsApp.setWindowMode(mode);
    setAppState(nextState);
  };

  const cycleDockCorner = async () => {
    const corners = ["bottom-left", "bottom-right", "top-right", "top-left"];
    const currentIndex = corners.indexOf(dockCorner);
    const nextCorner = corners[(currentIndex + 1) % corners.length];
    const nextState = await window.commsApp.setDockCorner(nextCorner);
    setAppState(nextState);
  };

  const setDockHeight = async (height) => {
    const nextState = await window.commsApp.setDockHeight(height);
    setAppState(nextState);
  };

  const handleUploadIcon = async () => {
    const iconPath = await window.commsApp.uploadIcon();
    if (iconPath) {
      updateForm({ iconSource: iconPath, iconKey: "custom" });
    }
  };

  const saveNotificationSettings = async (updates) => {
    if (!activeService) {
      return;
    }

    const nextState = await window.commsApp.saveService({
      ...activeService,
      notificationSettings: {
        ...activeService.notificationSettings,
        ...updates
      }
    });
    setAppState(nextState);
  };

  const toggleKeepAlive = async () => {
    if (!activeService) {
      return;
    }

    const nextState = await window.commsApp.saveService({
      ...activeService,
      keepAliveInBackground: !activeService.keepAliveInBackground
    });
    setAppState(nextState);
    if (!activeService.keepAliveInBackground) {
      setLoadedServiceIds((current) =>
        current.includes(activeService.id) ? current : [...current, activeService.id]
      );
    }
  };

  const handleCapturedNotification = async (service, payload) => {
    if (!service.notificationSettings?.captureWebNotifications) {
      return;
    }

    await window.commsApp.notifyServiceEvent({
      serviceId: service.id,
      serviceName: service.name,
      source: "web-notification",
      title: payload.title || service.name,
      body: payload.body || "New web notification"
    });
  };

  const handleTitleUpdate = async (service, title) => {
    const nextCount = service.notificationSettings?.badgeEnabled ? parseBadgeCount(title) : 0;

    setBadgeCounts((current) => ({
      ...current,
      [service.id]: nextCount
    }));

    const previousCount = notifiedCountsRef.current[service.id] ?? 0;
    notifiedCountsRef.current[service.id] = nextCount;

    if (nextCount > previousCount) {
      await window.commsApp.notifyServiceEvent({
        serviceId: service.id,
        serviceName: service.name,
        source: "badge",
        title: `${service.name} unread count increased`,
        body: `${nextCount} unread items`
      });
    }
  };

  const clearHistory = async () => {
    const nextState = await window.commsApp.clearNotificationHistory();
    setAppState(nextState);
  };

  const sendTestNotification = async () => {
    if (!activeService) {
      return;
    }

    await window.commsApp.notifyServiceEvent({
      serviceId: activeService.id,
      serviceName: activeService.name,
      source: "test",
      title: `${activeService.name} test alert`,
      body: "This is a sample notification from Comms Hub."
    });

    setStatusMessage(`Sent a test alert for ${activeService.name}.`);
  };

  const checkForUpdates = async () => {
    setIsCheckingUpdates(true);
    const result = await window.commsApp.checkForUpdates();
    setUpdateInfo(result);
    setIsCheckingUpdates(false);
    if (result.status === "update-available") {
      setStatusMessage(`Update available: ${result.latestVersion}.`);
    } else if (result.status === "up-to-date") {
      setStatusMessage(`Comms Hub ${result.currentVersion} is up to date.`);
    } else if (result.status === "error") {
      setStatusMessage("Unable to check for updates right now.");
    }
  };

  const openUpdateDownload = async () => {
    const opened = await window.commsApp.openUpdateDownload();
    if (opened) {
      setStatusMessage("Opened the latest release download.");
    }
  };

  if (isTriggerMode) {
    return (
      <div className={`dock-trigger-shell ${isRightAnchored ? "right-anchored" : "left-anchored"} ${dockCorner}`}>
        <div className="dock-trigger-tab" />
      </div>
    );
  }

  if (!appState) {
    return <div className="loading-shell">{statusMessage}</div>;
  }

  if (isDockMode) {
    return (
      <div className={`dock-shell ${isRightAnchored ? "right-anchored" : "left-anchored"} ${dockCorner}`}>
        <div className="dock-body">
          <aside className="dock-rail">
            <div className="dock-rail-stack">
              {services.map((service) => (
                <button
                  key={service.id}
                  className={`dock-rail-button ${service.id === activeServiceId ? "active" : ""}`}
                  onClick={async () => {
                    if (service.id === activeServiceId && dockExpanded) {
                      const nextState = await window.commsApp.setDockExpanded(false);
                      setAppState(nextState);
                      return;
                    }

                    const nextState = await window.commsApp.setActiveService(service.id);
                    const finalState = await window.commsApp.setDockExpanded(true);
                    setAppState(finalState?.ui?.activeServiceId ? finalState : nextState);
                  }}
                  title={service.name}
                  type="button"
                >
                  <span className="service-icon-wrap">
                    <img src={service.iconSource} alt={service.name} className="service-icon" />
                    {notificationCounts[service.id] ? (
                      <span className="badge-pill">{notificationCounts[service.id]}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
            <div className="dock-rail-footer">
              <button className="dock-footer-button" onClick={cycleDockCorner} title="Move dock corner" type="button">
                Corner
              </button>
              <button className="dock-footer-button" onClick={() => setWindowMode("full")} title="Open full app" type="button">
                Full
              </button>
            </div>
          </aside>
        </div>

        {modalForm ? (
          <ServiceFormModal
            form={modalForm}
            onChange={updateForm}
            onClose={() => setModalForm(null)}
            onSave={handleSave}
            onUploadIcon={handleUploadIcon}
            iconLibrary={appState.iconLibrary}
            canDelete={!appState.services.find((service) => service.id === modalForm.id)?.isBuiltIn}
            onDelete={handleDelete}
          />
        ) : null}
      </div>
    );
  }

  if (isBubbleMode) {
    return (
      <div className={`bubble-shell ${isRightAnchored ? "right-anchored" : "left-anchored"} ${dockCorner}`}>
        <div className="dock-webview-wrap dock-webview-solo">
          {!activeService ? (
            <EmptyState
              title="Pick an app from the dock"
              body="Click an icon on the dock to open a quick-access bubble."
            />
          ) : (
            renderedServices.map((service) => (
              <webview
                key={service.id}
                ref={(node) => {
                  if (node) {
                    webviewRefs.current[service.id] = node;
                  } else {
                    delete webviewRefs.current[service.id];
                  }
                }}
                className={`service-webview ${service.id === activeServiceId ? "visible" : "hidden"}`}
                src={service.url}
                partition={service.useDefaultSession ? undefined : service.sessionPartition}
                preload={guestPreloadPath}
                useragent={service.userAgent || undefined}
                allowpopups="false"
              />
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${appState.ui.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="titlebar-drag-region">
          <div className="titlebar-title">
            <svg viewBox="0 0 64 64" aria-hidden="true" className="titlebar-mark">
              <line x1="20" y1="32" x2="30" y2="32" />
              <line x1="30" y1="12" x2="30" y2="52" />
              <line x1="30" y1="12" x2="38" y2="12" />
              <line x1="30" y1="25.33" x2="38" y2="25.33" />
              <line x1="30" y1="38.67" x2="38" y2="38.67" />
              <line x1="30" y1="52" x2="38" y2="52" />
              <circle cx="14" cy="32" r="6" />
              <circle cx="44" cy="12" r="5.5" />
              <circle cx="44" cy="25.33" r="5.5" />
              <circle cx="44" cy="38.67" r="5.5" />
              <circle cx="44" cy="52" r="5.5" />
            </svg>
            <span>Comms Hub</span>
          </div>
          <div className="titlebar-actions">
            <button className="titlebar-mode-button" onClick={() => setWindowMode("dock")} type="button">
              Dock mode
            </button>
          </div>
      </div>

      <aside className="icon-rail">
        <div className="rail-brand" aria-label="Comms Hub">
            <div className="brand-badge">
              <svg viewBox="0 0 64 64" aria-hidden="true" className="brand-mark">
                <line x1="20" y1="32" x2="30" y2="32" />
                <line x1="30" y1="12" x2="30" y2="52" />
                <line x1="30" y1="12" x2="38" y2="12" />
                <line x1="30" y1="25.33" x2="38" y2="25.33" />
                <line x1="30" y1="38.67" x2="38" y2="38.67" />
                <line x1="30" y1="52" x2="38" y2="52" />
                <circle cx="14" cy="32" r="6" />
                <circle cx="44" cy="12" r="5.5" />
                <circle cx="44" cy="25.33" r="5.5" />
                <circle cx="44" cy="38.67" r="5.5" />
                <circle cx="44" cy="52" r="5.5" />
              </svg>
            </div>
          </div>

        <div className="rail-icons">
          {services.map((service) => (
            <button
              key={service.id}
              className={`rail-icon-button ${service.id === activeServiceId ? "active" : ""}`}
              onClick={() => selectService(service.id)}
              title={service.name}
              type="button"
            >
              <span className="service-icon-wrap">
                <img src={service.iconSource} alt={service.name} className="service-icon" />
                {notificationCounts[service.id] ? (
                  <span className="badge-pill">{notificationCounts[service.id]}</span>
                ) : null}
              </span>
            </button>
          ))}
          <button className="rail-add-button" onClick={openCreateModal} title="Add app" type="button">
            +
          </button>
        </div>

        <div className="rail-footer">
          <button
            className={`rail-settings-button ${appState.ui.sidebarCollapsed ? "" : "active"}`}
            onClick={toggleSidebarCollapsed}
            title={appState.ui.sidebarCollapsed ? "Open app settings" : "Hide app settings"}
            type="button"
          >
            <span aria-hidden="true">⚙</span>
          </button>
        </div>
      </aside>

      {!appState.ui.sidebarCollapsed ? (
        <aside className="sidebar">
          <div className="sidebar-top">
            <div>
              <p className="eyebrow">Selected app</p>
              <h1>{activeService?.name ?? "No service"}</h1>
            </div>
            <div className="sidebar-top-actions">
              {activeService ? (
                <button className="ghost-button" onClick={() => openEditModal(activeService)} type="button">
                  Edit
                </button>
              ) : null}
            </div>
          </div>

          {activeService ? (
            <>
              <div className="selected-service-card">
                <div className="selected-service-button">
                  <span className="service-icon-wrap">
                    <img src={activeService.iconSource} alt="" className="service-icon service-icon-large" />
                  </span>
                  <span className="selected-service-copy">
                    <span className="service-name">{activeService.name}</span>
                    <span className="service-subtitle">{getWorkspaceLabel(activeService)}</span>
                  </span>
                </div>

                <div className="selected-service-meta">
                  <div>
                    <span className="meta-label">Order</span>
                    <strong>{activeIndex + 1}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Alerts</span>
                    <strong>{notificationCounts[activeService.id] || 0}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Memory</span>
                    <strong>{getMemoryStateLabel(activeService, appState.ui.memorySaverEnabled)}</strong>
                  </div>
                </div>

                <p className="service-url">{activeService.url}</p>

                <div className="service-actions">
                  <button
                    className="icon-text-button"
                    disabled={activeIndex <= 0}
                    onClick={() => moveService(activeService.id, -1)}
                    type="button"
                  >
                    Move up
                  </button>
                  <button
                    className="icon-text-button"
                    disabled={activeIndex >= services.length - 1}
                    onClick={() => moveService(activeService.id, 1)}
                    type="button"
                  >
                    Move down
                  </button>
                  {!appState.services.find((service) => service.id === activeService.id)?.isBuiltIn ? (
                    <button
                      className="danger-button service-remove-button"
                      onClick={() => handleRemoveService(activeService.id)}
                      type="button"
                    >
                      Remove app
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="sidebar-section">
                <p className="eyebrow">Performance</p>
                <label className="setting-row">
                  <span>Keep alive in background</span>
                  <input
                    type="checkbox"
                    checked={activeService.keepAliveInBackground ?? false}
                    onChange={toggleKeepAlive}
                  />
                </label>
                <p className="setting-note">
                  Keeps this app mounted even when memory saver is on, so it can stay signed in and
                  continue background activity at the cost of more RAM.
                </p>
              </div>

              <div className="sidebar-section">
                <p className="eyebrow">Notification routing</p>
                <label className="setting-row">
                  <span>Desktop alerts</span>
                  <input
                    type="checkbox"
                    checked={activeService.notificationSettings?.desktopEnabled ?? true}
                    onChange={(event) =>
                      saveNotificationSettings({ desktopEnabled: event.target.checked })
                    }
                  />
                </label>
                <label className="setting-row">
                  <span>Sidebar badges</span>
                  <input
                    type="checkbox"
                    checked={activeService.notificationSettings?.badgeEnabled ?? true}
                    onChange={(event) =>
                      saveNotificationSettings({ badgeEnabled: event.target.checked })
                    }
                  />
                </label>
                <label className="setting-row">
                  <span>Capture web notifications</span>
                  <input
                    type="checkbox"
                    checked={activeService.notificationSettings?.captureWebNotifications ?? true}
                    onChange={(event) =>
                      saveNotificationSettings({ captureWebNotifications: event.target.checked })
                    }
                  />
                </label>
              </div>

              <div className="sidebar-section">
                <p className="eyebrow">Installed apps</p>
                <div className="mini-service-list">
                  {services.map((service) => (
                    <button
                      key={service.id}
                      className={`mini-service-row ${service.id === activeServiceId ? "active" : ""}`}
                      onClick={() => selectService(service.id)}
                      type="button"
                    >
                      <img src={service.iconSource} alt="" className="mini-service-icon" />
                      <span className="mini-service-copy">
                        <strong>{service.name}</strong>
                        <small>
                          {service.keepAliveInBackground
                            ? "Background keep-alive"
                            : service.id === activeServiceId
                              ? "Open now"
                              : "Switch view"}
                        </small>
                      </span>
                      {notificationCounts[service.id] ? (
                        <span className="mini-badge">{notificationCounts[service.id]}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <EmptyState />
          )}

          <div className="sidebar-footer">
            <div className="sidebar-section">
              <p className="eyebrow">Updates</p>
              <div className="update-summary">
                <strong>Installed</strong>
                <span>{updateInfo?.currentVersion ?? "0.0.0"}</span>
              </div>
              <div className="update-summary">
                <strong>Status</strong>
                <span>
                  {isCheckingUpdates
                    ? "Checking..."
                    : updateInfo?.status === "update-available"
                      ? `Update ${updateInfo.latestVersion} available`
                      : updateInfo?.status === "up-to-date"
                        ? "Up to date"
                        : updateInfo?.status === "error"
                          ? "Check failed"
                          : "Not configured"}
                </span>
              </div>
              {updateInfo?.status === "error" ? (
                <p className="setting-note">{updateInfo.error}</p>
              ) : null}
              <div className="update-actions">
                <button className="ghost-button" onClick={checkForUpdates} type="button">
                  Check for updates
                </button>
                {updateInfo?.status === "update-available" ? (
                  <button className="secondary-button" onClick={openUpdateDownload} type="button">
                    {updateInfo.assetName ? "Download update" : "Open release"}
                  </button>
                ) : null}
              </div>
            </div>
            {activeService ? (
              <button className="secondary-button sidebar-test-button" onClick={sendTestNotification} type="button">
                Send test alert
              </button>
            ) : null}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={appState.ui.notificationsEnabled}
                onChange={toggleNotifications}
              />
              <span>Global desktop notifications</span>
            </label>
            <label className="checkbox-row footer-checkbox">
              <input
                type="checkbox"
                checked={appState.ui.memorySaverEnabled}
                onChange={toggleMemorySaver}
              />
              <span>Memory saver mode</span>
            </label>
            <p className="footer-note">
              Memory saver unloads idle apps by default. Apps marked Keep alive in background stay
              mounted for background activity while the rest sleep to save RAM.
            </p>
            <div className="sidebar-section dock-settings-section">
              <p className="eyebrow">Dock mode</p>
              <label className="setting-row">
                <span>Dock height</span>
                <input
                  className="setting-number-input"
                  type="number"
                  min={dockHeightRange.min}
                  max={dockHeightRange.max}
                  step="10"
                  value={appState.ui.dockHeight ?? 420}
                  onChange={(event) => {
                    if (event.target.value === "") {
                      return;
                    }

                    setDockHeight(event.target.value);
                  }}
                />
              </label>
              <p className="setting-note">
                Controls the vertical size of the floating dock in pixels.
              </p>
            </div>
          </div>
        </aside>
      ) : null}

      <main className="workspace">
        <div className="workspace-body">
          {!activeService ? (
            <EmptyState />
          ) : modalForm ? (
            <div className="workspace-overlay-state">
              <p className="eyebrow">Service setup</p>
              <h2>Configure your app</h2>
              <p>The current web app is paused while the app settings dialog is open.</p>
            </div>
          ) : (
            renderedServices.map((service) => (
              <webview
                key={service.id}
                ref={(node) => {
                  if (node) {
                    webviewRefs.current[service.id] = node;
                  } else {
                    delete webviewRefs.current[service.id];
                  }
                }}
                className={`service-webview ${service.id === activeServiceId ? "visible" : "hidden"}`}
                src={service.url}
                partition={service.useDefaultSession ? undefined : service.sessionPartition}
                preload={guestPreloadPath}
                useragent={service.userAgent || undefined}
                allowpopups="false"
              />
            ))
          )}
        </div>
      </main>

      {modalForm ? (
        <ServiceFormModal
          form={modalForm}
          onChange={updateForm}
          onClose={() => setModalForm(null)}
          onSave={handleSave}
          onUploadIcon={handleUploadIcon}
          iconLibrary={appState.iconLibrary}
          canDelete={!appState.services.find((service) => service.id === modalForm.id)?.isBuiltIn}
          onDelete={handleDelete}
        />
      ) : null}
    </div>
  );
}

export default App;
