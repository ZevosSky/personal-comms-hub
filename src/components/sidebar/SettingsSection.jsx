import { useId } from "react";
import { formatMemory } from "../../lib/format.js";
import { DockHeightSetting, ToggleRow } from "./SettingControls.jsx";

const DEFAULT_DOCK_UNAVAILABLE =
  "Floating dock and pop-out are temporarily unavailable on Linux. Use the full app.";

function MemoryCard({ metrics, failed }) {
  const total = Number(metrics?.totalMemoryKB);
  const shell = Number(metrics?.shellMemoryKB);
  const hasTotal = Number.isFinite(total);
  return (
    <div className="memory-card" aria-live="off">
      <span className="memory-card-label">Comms Hub is using</span>
      <strong className="memory-card-value">{hasTotal ? formatMemory(total) : failed ? "Unavailable" : "Measuring…"}</strong>
      {hasTotal && Number.isFinite(shell) ? (
        <span className="memory-card-detail">
          {formatMemory(Math.max(0, total - shell))} in apps · {formatMemory(shell)} for Comms Hub itself
        </span>
      ) : null}
    </div>
  );
}

function UpdatesBlock({ updates }) {
  const { info, checking, check, openDownload } = updates;
  const status = checking
    ? "Checking…"
    : info?.status === "update-available"
      ? `Update ${info.latestVersion} available`
      : info?.status === "up-to-date"
        ? "Up to date"
        : info?.status === "error"
          ? "Check failed"
          : info?.status === "unconfigured"
            ? "Not configured"
            : "Not checked yet";
  return (
    <div className="settings-group">
      <p className="subheading">Updates</p>
      <div className="update-summary">
        <span>Installed</span>
        <strong>{info?.currentVersion ?? "—"}</strong>
      </div>
      <div className="update-summary">
        <span>Status</span>
        <strong className={info?.status === "update-available" ? "tone-ok" : info?.status === "error" ? "tone-error" : ""}>
          {status}
        </strong>
      </div>
      {info?.status === "error" && info.error && !checking ? <p className="setting-hint">{info.error}</p> : null}
      <div className="update-actions">
        <button className="ghost-button" onClick={() => check()} type="button" disabled={checking}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {info?.status === "update-available" ? (
          <button className="secondary-button" onClick={openDownload} type="button">
            {info.assetName ? "Download update" : "Open release"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Global settings.
export function SettingsSection({
  ui,
  limits,
  capabilities,
  metrics,
  metricsSupported,
  metricsFailed,
  settingsSupported,
  actions,
  updates
}) {
  const timeoutId = useId();
  const dockModeSupported = capabilities?.dockModeSupported ?? false;
  const dockUnavailableReason = capabilities?.dockModeUnavailableReason ?? DEFAULT_DOCK_UNAVAILABLE;
  const timeoutMinutes = Number(ui.memorySaverTimeoutMinutes) || 10;
  const timeoutOptions = limits.memorySaverTimeoutOptions.includes(timeoutMinutes)
    ? limits.memorySaverTimeoutOptions
    : [...limits.memorySaverTimeoutOptions, timeoutMinutes].sort((a, b) => a - b);

  return (
    <section className="sidebar-section" aria-labelledby="settings-heading">
      <div className="section-heading">
        <p className="eyebrow" id="settings-heading">
          Settings
        </p>
      </div>

      <div className="settings-group">
        <p className="subheading">Memory</p>
        {metricsSupported ? <MemoryCard metrics={metrics} failed={metricsFailed} /> : null}
        <ToggleRow
          label="Memory saver"
          hint="Puts apps you aren't using to sleep. Sleeping apps keep their sign-in but pause alerts."
          checked={ui.memorySaverEnabled}
          onChange={actions.setMemorySaverEnabled}
        />
        {settingsSupported ? (
          <div className={`setting-row ${ui.memorySaverEnabled ? "" : "is-disabled"}`}>
            <span className="setting-copy">
              <label className="setting-label" htmlFor={timeoutId}>
                Sleep after
              </label>
              <span className="setting-hint">Open, kept-alive, and busy apps (calls, drafts) stay awake.</span>
            </span>
            <select
              id={timeoutId}
              className="setting-select"
              value={timeoutMinutes}
              disabled={!ui.memorySaverEnabled}
              onChange={(event) => actions.setAppSettings({ memorySaverTimeoutMinutes: Number(event.target.value) })}
            >
              {timeoutOptions.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min idle
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <p className="subheading">Notifications</p>
        <ToggleRow
          label="Desktop notifications"
          hint="Master switch for every app's desktop alerts."
          checked={ui.notificationsEnabled}
          onChange={actions.setNotificationsEnabled}
        />
      </div>

      {settingsSupported ? (
        <div className="settings-group">
          <p className="subheading">Window &amp; startup</p>
          <ToggleRow
            label="Keep running in tray when closed"
            hint="Closing the window hides Comms Hub instead of quitting."
            checked={ui.closeToTray}
            onChange={(closeToTray) => actions.setAppSettings({ closeToTray })}
          />
          <ToggleRow
            label="Launch at login"
            checked={ui.launchAtLogin}
            onChange={(launchAtLogin) => actions.setAppSettings({ launchAtLogin })}
          />
          <ToggleRow
            label="Start minimized"
            hint="Start in the tray."
            checked={ui.startMinimized}
            onChange={(startMinimized) => actions.setAppSettings({ startMinimized })}
          />
          <ToggleRow
            label="Ask where to save downloads"
            hint="Off: downloads go straight to your Downloads folder."
            checked={ui.askWhereToSaveDownloads}
            onChange={(askWhereToSaveDownloads) => actions.setAppSettings({ askWhereToSaveDownloads })}
          />
        </div>
      ) : null}

      <div className="settings-group">
        <p className="subheading">Dock</p>
        {dockModeSupported ? (
          <DockHeightSetting
            value={Number(ui.dockHeight) || 420}
            limits={limits.dockHeight}
            onCommit={actions.setDockHeight}
          />
        ) : (
          <p className="dock-unavailable-note">{dockUnavailableReason}</p>
        )}
      </div>

      <UpdatesBlock updates={updates} />
    </section>
  );
}
