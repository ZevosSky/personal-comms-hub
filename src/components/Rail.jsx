import { BrandMark, Icon } from "./Icon.jsx";
import { RailServiceList } from "./RailServiceList.jsx";

// Left rail of the full window.
export function Rail({ sidebarOpen, onAddApp, onToggleSidebar, ...listProps }) {
  return (
    <aside className="icon-rail">
      <div className="rail-brand">
        <div className="brand-badge">
          <BrandMark className="brand-mark" />
        </div>
      </div>
      <div className="rail-scroll">
        <RailServiceList className="rail-icons" variant="full" {...listProps} />
        <button className="rail-add-button" onClick={onAddApp} title="Add app" aria-label="Add app" type="button">
          <Icon name="plus" size={22} />
        </button>
      </div>
      <div className="rail-footer">
        <button
          className={`rail-settings-button ${sidebarOpen ? "active" : ""}`}
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide settings (Ctrl+,)" : "Show settings (Ctrl+,)"}
          aria-label={sidebarOpen ? "Hide settings" : "Show settings"}
          aria-expanded={sidebarOpen}
          type="button"
        >
          <Icon name="settings" size={22} />
        </button>
      </div>
    </aside>
  );
}
