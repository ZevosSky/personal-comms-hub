import { formatCpu, formatMemory, getConditionTone, getMemoryStateLabel, getServiceCondition } from "../../lib/format.js";
import { ZoomControls } from "../ZoomControls.jsx";
import { ToggleRow } from "./SettingControls.jsx";

// Per-app section for the selected app.
export function ThisAppSection({
  service,
  runtime,
  ui,
  metric,
  metricsSupported,
  zoomLimits,
  canMoveUp,
  canMoveDown,
  can,
  actions,
  onEdit
}) {
  const condition = getServiceCondition(service, runtime);
  const label = getMemoryStateLabel(service, ui, runtime);
  const loaded = Boolean(runtime?.webContentsId);
  const settings = service.notificationSettings ?? {};

  return (
    <section className="sidebar-section this-app" aria-labelledby="this-app-heading">
      <div className="section-heading">
        <p className="eyebrow" id="this-app-heading">
          This app
        </p>
        <span className={`status-chip tone-${getConditionTone(condition)}`}>{label}</span>
      </div>

      <div className="app-identity">
        <img src={service.iconSource} alt="" className="service-icon service-icon-large" />
        <div className="app-identity-copy">
          <h1 className="app-name">{service.name}</h1>
          <p className="service-url" title={service.url}>
            {service.url}
          </p>
        </div>
      </div>

      <div className="app-actions">
        <button className="ghost-button" onClick={actions.refreshActive} type="button">
          Refresh
        </button>
        <button className="ghost-button" onClick={onEdit} type="button">
          Edit
        </button>
        {can.navigate ? (
          <button className="ghost-button" onClick={() => actions.navigate("open-in-browser")} type="button">
            Open in browser
          </button>
        ) : null}
      </div>

      {metricsSupported ? (
        <div className="metric-grid" aria-label="Resource use">
          <div className="metric">
            <span className="meta-label">Memory</span>
            <strong>{loaded ? formatMemory(metric?.memoryKB) : "Not loaded"}</strong>
          </div>
          <div className="metric">
            <span className="meta-label">CPU</span>
            <strong>{loaded ? formatCpu(metric?.cpuPercent) : "—"}</strong>
          </div>
          {loaded && metric?.shared ? (
            <p className="setting-hint metric-note">Shares a process with another app, so this is approximate.</p>
          ) : null}
        </div>
      ) : null}

      <div className="setting-list">
        {can.sleep ? (
          <div className="setting-row">
            <span className="setting-copy">
              <span className="setting-label">Sleep now</span>
              <span className="setting-hint">Frees its memory. Alerts pause until you open it again.</span>
            </span>
            <span
              className="disabled-hint"
              title={
                loaded
                  ? "This is the app you're viewing. Switch to another app first, or use Sleep in the Apps list or the rail's right-click menu."
                  : "This app isn't loaded, so there's nothing to free."
              }
            >
              <button className="compact-action-button" type="button" disabled>
                Sleep now
              </button>
            </span>
          </div>
        ) : null}
        <ToggleRow
          label="Keep alive in background"
          hint={loaded || runtime?.manuallySlept ? "Stays connected for live alerts." : "Stays connected for live alerts once opened."}
          checked={service.keepAliveInBackground}
          onChange={() => actions.toggleKeepAlive(service)}
        />
        <div className="setting-row">
          <span className="setting-copy">
            <span className="setting-label">Page zoom</span>
          </span>
          <ZoomControls service={service} limits={zoomLimits} onChange={actions.setZoom} />
        </div>
        <ToggleRow
          label="Desktop alerts"
          hint="Show a notification when this app sends one."
          checked={settings.desktopEnabled ?? true}
          onChange={(desktopEnabled) => actions.saveNotificationSettings(service, { desktopEnabled })}
        />
        <ToggleRow
          label="Unread badge"
          hint="Read the unread count from the page title."
          checked={settings.badgeEnabled ?? true}
          onChange={(badgeEnabled) => actions.saveNotificationSettings(service, { badgeEnabled })}
        />
      </div>

      <div className="app-footer-actions">
        <button className="icon-text-button" disabled={!canMoveUp} onClick={() => actions.moveService(service.id, -1)} type="button">
          Move up
        </button>
        <button className="icon-text-button" disabled={!canMoveDown} onClick={() => actions.moveService(service.id, 1)} type="button">
          Move down
        </button>
        <button className="link-button" onClick={() => actions.sendTestAlert(service)} type="button">
          Send test alert
        </button>
        {service.isBuiltIn ? (
          <button className="danger-button compact service-remove-button" onClick={() => actions.hideService(service.id)} type="button">
            Hide on this device
          </button>
        ) : (
          <button className="danger-button compact service-remove-button" onClick={() => actions.removeService(service.id)} type="button">
            Remove app
          </button>
        )}
      </div>
    </section>
  );
}
