import { useId, useMemo, useRef, useState } from "react";
import { useDialog } from "../hooks/useDialog.js";

// Earlier builds remembered the system-audio choice; it now starts unchecked every time (D9).
try {
  window.localStorage.removeItem("comms-hub.screen-share.share-audio");
} catch {
  // Storage can be unavailable.
}

const isWindowSource = (source) =>
  source?.kind === "window" || (!source?.kind && String(source?.id ?? "").startsWith("window:"));

// In-app screen share picker (D9). The caller obscures the service viewport while it is open.
export function ScreenSharePicker({ request, onRespond }) {
  const sources = useMemo(
    () => (Array.isArray(request?.sources) ? request.sources.filter((source) => source?.id) : []),
    [request]
  );
  const screens = sources.filter((source) => !isWindowSource(source));
  const windows = sources.filter(isWindowSource);
  const [tab, setTab] = useState(screens.length || !windows.length ? "screens" : "windows");
  const [selectedId, setSelectedId] = useState(null);
  const [shareAudio, setShareAudio] = useState(false);
  const dialogRef = useRef(null);
  const gridRef = useRef(null);
  const firstSourceRef = useRef(null);
  const ids = useId();
  const audioRequested = Boolean(request?.audioRequested);
  const serviceName = request?.serviceName || "This app";
  // Set when the page asking is not part of the service's own site (a frame or popup elsewhere).
  const foreignOrigin = typeof request?.foreignOrigin === "string" && request.foreignOrigin ? request.foreignOrigin : null;
  const visible = tab === "screens" ? screens : windows;
  // Only a source highlighted on the current tab counts.
  const selected = visible.find((source) => source.id === selectedId) ?? null;

  const cancel = () => onRespond({ sourceId: null, shareAudio: false });
  const share = (sourceId = selected?.id) => {
    if (!sourceId) return;
    onRespond({ sourceId, shareAudio: audioRequested && shareAudio });
  };
  const switchTab = (next) => {
    setTab(next);
    setSelectedId(null);
  };

  // Keyboard focus starts on the first source (arrows pick, Enter shares, Esc cancels).
  useDialog(dialogRef, { initialFocusRef: firstSourceRef, onEscape: cancel });

  const focusSource = (index) => {
    const buttons = gridRef.current?.querySelectorAll('[role="radio"]');
    const button = buttons?.[index];
    if (!button) return;
    button.focus();
    setSelectedId(visible[index]?.id ?? null);
  };

  const onGridKeyDown = (event) => {
    const buttons = Array.from(gridRef.current?.querySelectorAll('[role="radio"]') ?? []);
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const columns = Math.max(1, buttons.filter((button) => button.offsetTop === buttons[0].offsetTop).length);
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    if (event.key in moves) {
      event.preventDefault();
      focusSource(Math.max(0, Math.min(buttons.length - 1, index + moves[event.key])));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusSource(event.key === "Home" ? 0 : buttons.length - 1);
    } else if (event.key === "Enter" && selectedId === visible[index]?.id) {
      event.preventDefault();
      share();
    }
  };

  const tabs = [
    { key: "screens", label: "Screens", count: screens.length },
    { key: "windows", label: "Windows", count: windows.length }
  ];
  const activeInGroup = visible.findIndex((source) => source.id === selectedId);

  return (
    <div className="modal-backdrop share-backdrop">
      <div
        ref={dialogRef}
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={foreignOrigin ? `${ids}-subtitle ${ids}-origin` : `${ids}-subtitle`}
        tabIndex={-1}
      >
        <div className="share-header">
          <div>
            <p className="eyebrow">Screen sharing</p>
            <h2 id={`${ids}-title`}>Choose what to share</h2>
            <p className="share-subtitle" id={`${ids}-subtitle`}>
              {request?.serviceName ? `${request.serviceName} wants to share your screen.` : "An app wants to share your screen."}
            </p>
            {foreignOrigin ? (
              <p className="share-origin" id={`${ids}-origin`}>
                {`Requested by ${foreignOrigin}, which is not part of ${serviceName}'s own site.`}
              </p>
            ) : null}
          </div>
        </div>

        <div className="share-tabs" role="tablist" aria-label="Source type">
          {tabs.map((item) => (
            <button
              key={item.key}
              id={`${ids}-tab-${item.key}`}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              aria-controls={`${ids}-panel`}
              tabIndex={tab === item.key ? 0 : -1}
              className={`share-tab ${tab === item.key ? "active" : ""}`}
              onClick={() => {
                if (tab !== item.key) switchTab(item.key);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const next = item.key === "screens" ? "windows" : "screens";
                  switchTab(next);
                  document.getElementById(`${ids}-tab-${next}`)?.focus();
                }
              }}
            >
              {item.label} <span className="share-tab-count">{item.count}</span>
            </button>
          ))}
        </div>

        <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className="share-panel">
          {visible.length ? (
            <div
              ref={gridRef}
              className="share-grid"
              role="radiogroup"
              aria-label={tab === "screens" ? "Screens" : "Windows"}
              onKeyDown={onGridKeyDown}
            >
              {visible.map((source, index) => {
                const checked = source.id === selectedId;
                const focusable = activeInGroup >= 0 ? index === activeInGroup : index === 0;
                return (
                  <button
                    key={source.id}
                    ref={index === 0 ? firstSourceRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={focusable ? 0 : -1}
                    className={`share-source ${checked ? "selected" : ""}`}
                    onClick={() => setSelectedId(source.id)}
                    onDoubleClick={() => share(source.id)}
                    title={source.name}
                  >
                    <span className="share-thumb">
                      {source.thumbnailDataUrl ? <img src={source.thumbnailDataUrl} alt="" /> : null}
                    </span>
                    <span className="share-source-name">
                      {source.appIconDataUrl ? <img className="share-app-icon" src={source.appIconDataUrl} alt="" /> : null}
                      <span>{source.name || (isWindowSource(source) ? "Window" : "Screen")}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="share-empty">
              {tab === "screens" ? "No screens are available to share." : "No windows are available to share."}
            </p>
          )}
        </div>

        <div className="share-footer">
          {audioRequested ? (
            <label className="checkbox-row">
              <input type="checkbox" checked={shareAudio} onChange={(event) => setShareAudio(event.target.checked)} />
              <span>Also share system audio</span>
            </label>
          ) : (
            <span />
          )}
          <div className="modal-actions-end">
            <button type="button" className="ghost-button" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!selected}
              onClick={() => share()}
              title={selected ? `Share ${selected.name}` : "Pick a screen or window first"}
            >
              Share
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
