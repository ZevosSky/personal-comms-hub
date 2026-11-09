import { Icon } from "./Icon.jsx";

// Status line for the titlebar (full) and bubble toolbar. Lives outside the service viewport so
// the native page never covers it. Two live regions so errors are announced assertively.
export function StatusArea({ message, onDismiss, className = "" }) {
  const info = message?.tone === "info" ? message : null;
  const error = message?.tone === "error" ? message : null;
  return (
    <div className={`status-area ${className}`}>
      <div className="status-region" role="status" aria-live="polite" aria-atomic="true">
        {info ? (
          <span className="status-pill tone-info" title={info.text}>
            <span className="status-text">{info.text}</span>
          </span>
        ) : null}
      </div>
      <div className="status-region" role="alert" aria-live="assertive" aria-atomic="true">
        {error ? (
          <span className="status-pill tone-error" title={error.text}>
            <span className="status-text">{error.text}</span>
            <button
              type="button"
              className="status-dismiss"
              aria-label="Dismiss message"
              title="Dismiss"
              onClick={() => onDismiss?.(error.id)}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
