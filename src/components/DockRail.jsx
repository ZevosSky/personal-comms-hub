import { Icon } from "./Icon.jsx";
import { RailServiceList } from "./RailServiceList.jsx";

// Narrow always-on-top dock (dock window). Clicking the active app collapses the bubble.
export function DockRail({ onReload, onCycleCorner, onOpenFull, error, onDismissError, ...listProps }) {
  return (
    <aside className="dock-rail">
      <RailServiceList className="dock-rail-stack" variant="dock" {...listProps} />
      <div className="dock-rail-footer">
        <div role="alert" className="dock-alert-slot">
          {error ? (
            <button
              className="dock-footer-button is-error"
              onClick={onDismissError}
              title={`${error.text} (click to dismiss)`}
              aria-label={`Dismiss error: ${error.text}`}
              type="button"
            >
              !
            </button>
          ) : null}
        </div>
        <button className="dock-footer-button" onClick={onReload} title="Reload app" aria-label="Reload app" type="button">
          <Icon name="reload" size={16} />
        </button>
        <button className="dock-footer-button" onClick={onCycleCorner} title="Move dock to next corner" aria-label="Move dock to next corner" type="button">
          <Icon name="corner" size={16} />
        </button>
        <button className="dock-footer-button" onClick={onOpenFull} title="Open full app" aria-label="Open full app" type="button">
          <Icon name="expand" size={16} />
        </button>
      </div>
    </aside>
  );
}
