import { Icon } from "./Icon.jsx";
import { StatusArea } from "./StatusArea.jsx";
import { ZoomControls } from "./ZoomControls.jsx";

// Toolbar above the bubble's service viewport (must stay >= 30 px tall).
export function BubbleToolbar({
  service,
  runtime,
  canNavigate,
  zoomLimits,
  status,
  onDismissStatus,
  onBack,
  onReload,
  onZoom,
  onCollapse,
  onOpenFull
}) {
  return (
    <div className="bubble-toolbar">
      <span className="bubble-toolbar-label" title={service?.name}>
        {service?.iconSource ? <img src={service.iconSource} alt="" className="bubble-toolbar-icon" /> : null}
        <span>{service?.name ?? "Comms Hub"}</span>
      </span>
      {service ? (
        <div className="bubble-toolbar-group">
          {canNavigate ? (
            <button
              type="button"
              className="toolbar-icon-button"
              aria-label="Back"
              title="Back (Alt+Left)"
              disabled={runtime?.canGoBack === false}
              onClick={onBack}
            >
              <Icon name="back" size={15} />
            </button>
          ) : null}
          <button type="button" className="toolbar-icon-button" aria-label={`Reload ${service.name}`} title="Reload (Ctrl+R)" onClick={onReload}>
            <Icon name="reload" size={15} />
          </button>
          <ZoomControls service={service} limits={zoomLimits} onChange={onZoom} />
        </div>
      ) : null}
      <StatusArea className="bubble-status" message={status} onDismiss={onDismissStatus} />
      <div className="bubble-toolbar-group">
        <button type="button" className="toolbar-icon-button" aria-label="Collapse to dock" title="Collapse (Esc)" onClick={onCollapse}>
          <Icon name="minimize" size={15} />
        </button>
        <button type="button" className="toolbar-icon-button" aria-label="Open full app" title="Open full app" onClick={onOpenFull}>
          <Icon name="expand" size={15} />
        </button>
      </div>
    </div>
  );
}
