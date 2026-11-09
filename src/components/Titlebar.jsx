import { BrandMark, Icon } from "./Icon.jsx";
import { StatusArea } from "./StatusArea.jsx";

// Full-window titlebar. Draggable except for its controls; the right edge stays clear for the
// Windows caption buttons (titleBarOverlay).
export function Titlebar({
  activeService,
  activeRuntime,
  canNavigate,
  canFind,
  findOpen,
  status,
  onDismissStatus,
  onNavigate,
  onReload,
  onFind,
  dockModeSupported,
  dockUnavailableReason,
  onDockMode
}) {
  const hasService = Boolean(activeService);
  const name = activeService?.name ?? "app";
  return (
    <header className="titlebar titlebar-drag-region">
      <div className="titlebar-title">
        <BrandMark className="titlebar-mark" />
        <span>Comms Hub</span>
      </div>

      {hasService ? (
        <div className="titlebar-nav" role="toolbar" aria-label={`${name} navigation`}>
          {canNavigate ? (
            <>
              <button
                type="button"
                className="titlebar-icon-button"
                aria-label="Back"
                title="Back (Alt+Left)"
                disabled={activeRuntime?.canGoBack === false}
                onClick={() => onNavigate("back")}
              >
                <Icon name="back" />
              </button>
              <button
                type="button"
                className="titlebar-icon-button"
                aria-label="Forward"
                title="Forward (Alt+Right)"
                disabled={activeRuntime?.canGoForward === false}
                onClick={() => onNavigate("forward")}
              >
                <Icon name="forward" />
              </button>
              <button
                type="button"
                className="titlebar-icon-button"
                aria-label={`${name} home`}
                title={`Go to ${name} home`}
                onClick={() => onNavigate("home")}
              >
                <Icon name="home" />
              </button>
            </>
          ) : null}
          <button type="button" className="titlebar-icon-button" aria-label={`Reload ${name}`} title="Reload (Ctrl+R)" onClick={onReload}>
            <Icon name="reload" />
          </button>
          {canFind ? (
            <button
              type="button"
              className={`titlebar-icon-button ${findOpen ? "active" : ""}`}
              aria-label={`Find in ${name}`}
              aria-pressed={findOpen}
              title="Find in page (Ctrl+F)"
              onClick={onFind}
            >
              <Icon name="search" />
            </button>
          ) : null}
        </div>
      ) : null}

      <StatusArea className="titlebar-status" message={status} onDismiss={onDismissStatus} />

      <div className="titlebar-actions">
        <button
          className="titlebar-mode-button"
          disabled={!dockModeSupported}
          title={dockModeSupported ? "Switch to the floating dock" : dockUnavailableReason}
          onClick={onDockMode}
          type="button"
        >
          <Icon name="dock" size={15} />
          <span>{dockModeSupported ? "Dock mode" : "Dock unavailable on Linux"}</span>
        </button>
      </div>
    </header>
  );
}
