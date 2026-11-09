export function EmptyState({ eyebrow = "No app selected", title, body, action }) {
  return (
    <div className="empty-state">
      <div className="empty-state-inner">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title ?? "Choose an app from the left rail"}</h2>
        <p>{body ?? "Each app keeps its own sign-in and can be reopened anytime."}</p>
        {action ?? null}
      </div>
    </div>
  );
}

export function ShellMessage({ title, body, action, busy = false }) {
  return (
    <div className="loading-shell" role={busy ? "status" : "alert"}>
      <div className="loading-card">
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        <p className="loading-title">{title}</p>
        {body ? <p className="loading-body">{body}</p> : null}
        {action ?? null}
      </div>
    </div>
  );
}
