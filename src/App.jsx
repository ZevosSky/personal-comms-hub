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

function App() {
  const [appState, setAppState] = useState(null);
  const [modalForm, setModalForm] = useState(null);
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

  const services = useMemo(
    () => appState?.services?.filter((service) => service.isEnabled) ?? [],
    [appState]
  );
  const activeServiceId =
    appState?.ui?.activeServiceId ?? services.find((service) => service.isEnabled)?.id ?? null;
  const activeService = services.find((service) => service.id === activeServiceId) ?? null;
  const activeIndex = services.findIndex((service) => service.id === activeServiceId);
  const totalUnread = Object.values(badgeCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  const renderedServices = useMemo(() => {
    if (!activeService || !guestPreloadPath) {
      return [];
    }

    if (appState?.ui?.memorySaverEnabled) {
      return [activeService];
    }

    return services.filter((service) => loadedServiceIds.includes(service.id));
  }, [activeService, appState?.ui?.memorySaverEnabled, guestPreloadPath, loadedServiceIds, services]);

  useEffect(() => {
    if (!activeServiceId) {
      return;
    }

    setLoadedServiceIds((current) => (current.includes(activeServiceId) ? current : [...current, activeServiceId]));
  }, [activeServiceId]);

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
    setAppState(nextState);
    setStatusMessage(`Switched to ${nextState.services.find((service) => service.id === serviceId)?.name ?? "service"}.`);
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

  if (!appState) {
    return <div className="loading-shell">{statusMessage}</div>;
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
                {badgeCounts[service.id] ? <span className="badge-pill">{badgeCounts[service.id]}</span> : null}
              </span>
            </button>
          ))}
          <button className="rail-add-button" onClick={openCreateModal} title="Add app" type="button">
            +
          </button>
        </div>

        <div className="rail-footer">
          <div className="rail-stat">
            <span>{services.length}</span>
            <small>apps</small>
          </div>
          <div className="rail-stat">
            <span>{totalUnread}</span>
            <small>unread</small>
          </div>
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
                    <span className="meta-label">Unread</span>
                    <strong>{badgeCounts[activeService.id] || 0}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Memory</span>
                    <strong>{appState.ui.memorySaverEnabled ? "Saver on" : "Warm tabs"}</strong>
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
                </div>
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
                        <small>{service.id === activeServiceId ? "Open now" : "Switch view"}</small>
                      </span>
                      {badgeCounts[service.id] ? <span className="mini-badge">{badgeCounts[service.id]}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <EmptyState />
          )}

          <div className="sidebar-footer">
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
              Memory saver keeps only the active service mounted. Turn it off if you want faster
              switching and more background activity at the cost of RAM.
            </p>
          </div>
        </aside>
      ) : null}

      <main className="workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Active service</p>
            <h2>{activeService?.name ?? "None"}</h2>
          </div>
          <div className="workspace-actions">
            <div className="workspace-chip">
              {appState.ui.memorySaverEnabled ? "Memory saver enabled" : "Warm tab caching enabled"}
            </div>
            {activeService ? (
              <button
                className="secondary-button"
                onClick={() => window.commsApp.openExternal(activeService.url)}
                type="button"
              >
                Open in browser
              </button>
            ) : null}
          </div>
        </div>

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
                partition={service.sessionPartition}
                preload={guestPreloadPath}
                useragent={service.userAgent || undefined}
                allowpopups="false"
              />
            ))
          )}
        </div>

        <section className="notification-center">
          <div className="notification-center-header">
            <div>
              <p className="eyebrow">Notification center</p>
              <h3>Recent activity</h3>
            </div>
            <button className="ghost-button" onClick={clearHistory} type="button">
              Clear
            </button>
          </div>
          <div className="notification-list">
            {appState.notificationHistory?.length ? (
              appState.notificationHistory.slice(0, 6).map((entry) => (
                <article className="notification-item" key={entry.id}>
                  <div className="notification-item-top">
                    <strong>{entry.serviceName}</strong>
                    <span>{new Date(entry.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                  <p>{entry.title}</p>
                  <small>{entry.body}</small>
                </article>
              ))
            ) : (
              <div className="notification-empty">No notifications yet.</div>
            )}
          </div>
        </section>

        <div className="status-bar">{statusMessage}</div>
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
