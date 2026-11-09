import {
  formatBadgeCount,
  formatMemory,
  getConditionTone,
  getMemoryStateLabel,
  getServiceCondition
} from "../../lib/format.js";
import { Icon } from "../Icon.jsx";

// All apps with status, memory and unread; click selects. Hidden apps can be restored.
export function AppsSection({
  services,
  hiddenServices,
  activeId,
  runtimeServices,
  ui,
  metrics,
  badges,
  canSleep,
  onSelect,
  onSleep,
  onRestore
}) {
  return (
    <section className="sidebar-section" aria-labelledby="apps-heading">
      <div className="section-heading">
        <p className="eyebrow" id="apps-heading">
          Apps
        </p>
        <span className="section-count">{services.length}</span>
      </div>
      {services.length ? (
        <ul className="mini-service-list">
          {services.map((service) => {
            const runtime = runtimeServices[service.id];
            const condition = getServiceCondition(service, runtime);
            const loaded = Boolean(runtime?.webContentsId);
            const isActive = service.id === activeId;
            const memoryKB = metrics?.services?.[service.id]?.memoryKB;
            const badge = badges[service.id];
            const sleepable = canSleep && loaded && !isActive && runtime?.status !== "closing";
            return (
              <li key={service.id} className={`app-row ${isActive ? "active" : ""}`}>
                <button
                  type="button"
                  className="app-row-main"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => onSelect(service.id)}
                >
                  <img src={service.iconSource} alt="" className={`mini-service-icon is-${condition}`} />
                  <span className="mini-service-copy">
                    <strong>{service.name}</strong>
                    <small className={`tone-${getConditionTone(condition)}`}>
                      {getMemoryStateLabel(service, ui, runtime)}
                    </small>
                  </span>
                  {metrics ? (
                    <span className="app-row-memory" title="Memory in use">
                      {loaded && Number.isFinite(Number(memoryKB)) ? formatMemory(memoryKB) : "—"}
                    </span>
                  ) : null}
                  {badge?.count ? (
                    <span
                      className={`mini-badge ${badge.kind === "alerts" ? "is-alerts" : ""}`}
                      aria-label={badge.kind === "unread" ? `${badge.count} unread` : `${badge.count} new alerts`}
                    >
                      {formatBadgeCount(badge.count)}
                    </span>
                  ) : null}
                </button>
                {sleepable ? (
                  <button
                    type="button"
                    className="row-action-button"
                    aria-label={`Put ${service.name} to sleep`}
                    title={`Put ${service.name} to sleep (frees memory, pauses alerts)`}
                    onClick={() => onSleep(service)}
                  >
                    <Icon name="moon" size={14} />
                  </button>
                ) : canSleep ? (
                  <span className="row-action-spacer" aria-hidden="true" />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="setting-hint">No apps are shown. Add one with the + button or restore a hidden app.</p>
      )}

      {hiddenServices.length ? (
        <div className="hidden-apps">
          <p className="subheading">Hidden on this device</p>
          <ul className="mini-service-list">
            {hiddenServices.map((service) => (
              <li className="app-row hidden-service-row" key={service.id}>
                <span className="app-row-main is-static">
                  <img src={service.iconSource} alt="" className="mini-service-icon is-hidden" />
                  <span className="mini-service-copy">
                    <strong>{service.name}</strong>
                    <small>Hidden</small>
                  </span>
                </span>
                <button className="compact-action-button" onClick={() => onRestore(service.id)} type="button">
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
