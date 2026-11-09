import { useId, useMemo, useRef, useState } from "react";
import { useDialog } from "../hooks/useDialog.js";
import { describeError } from "../lib/bridge.js";
import { NAME_MAX_LENGTH, validateServiceForm } from "../lib/url.js";

// Add/Edit app dialog. The first `.ghost-button` inside `.modal` must stay the Close button
// (tests/fixtures/app-shell.mjs clicks it).
export function ServiceFormModal({
  initialForm,
  isBuiltIn,
  iconLibrary = [],
  canUploadIcon,
  onClose,
  onSave,
  onDelete,
  onUploadIcon
}) {
  const [form, setForm] = useState(initialForm);
  const [touched, setTouched] = useState({ name: false, url: false });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  // Errors show inside the dialog: its backdrop covers the titlebar status area.
  const [iconError, setIconError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const dialogRef = useRef(null);
  const nameRef = useRef(null);
  const pressedOnBackdrop = useRef(false);
  const ids = useId();

  useDialog(dialogRef, { initialFocusRef: nameRef, onEscape: onClose });

  const validation = useMemo(() => validateServiceForm(form), [form]);
  const fieldError = (field) => ((touched[field] || submitted) && validation.errors[field]) || null;
  const nameError = fieldError("name");
  const urlError = fieldError("url");
  const urlWarning = !urlError && validation.warnings.url;
  const isEditing = Boolean(form.id);
  const isLibraryIcon = iconLibrary.some((icon) => icon.iconSource === form.iconSource);

  const update = (changes) => setForm((current) => ({ ...current, ...changes }));
  const touch = (field) => setTouched((current) => ({ ...current, [field]: true }));

  const submit = async (event) => {
    event.preventDefault();
    setSubmitted(true);
    if (!validation.valid || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await onSave({ ...form, name: validation.name, url: validation.url });
      if (result && !result.ok) setActionError(`Couldn't save the app: ${describeError(result.error)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await onDelete();
      // A cancelled confirm is not an error.
      if (result && !result.ok && !result.cancelled) {
        setActionError(`Couldn't remove ${initialForm.name || "the app"}: ${describeError(result.error)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    // Cleared first so a repeated error is inserted (and announced) again.
    setIconError(null);
    const result = await onUploadIcon();
    if (result?.error) setIconError(result.error);
    else if (result?.iconSource) update({ iconSource: result.iconSource, iconKey: "custom" });
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        pressedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedOnBackdrop.current && event.target === event.currentTarget) onClose();
        pressedOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        tabIndex={-1}
      >
        <form
          onSubmit={submit}
          noValidate
          onKeyDown={(event) => {
            // Save is disabled while invalid, which blocks implicit submission; show why instead.
            if (event.key === "Enter" && event.target.tagName === "INPUT" && event.target.type === "text" && !validation.valid) {
              setSubmitted(true);
            }
          }}
        >
          <div className="modal-header">
            <div>
              <p className="eyebrow">{isEditing ? "App settings" : "New app"}</p>
              <h2 id={`${ids}-title`}>{isEditing ? `Edit ${initialForm.name || "app"}` : "Add app"}</h2>
            </div>
            <button className="ghost-button" onClick={onClose} type="button">
              Close
            </button>
          </div>

          <div className={`field ${nameError ? "has-error" : ""}`}>
            <label htmlFor={`${ids}-name`}>Name</label>
            <input
              id={`${ids}-name`}
              ref={nameRef}
              type="text"
              value={form.name}
              maxLength={NAME_MAX_LENGTH}
              autoComplete="off"
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? `${ids}-name-error` : undefined}
              onChange={(event) => update({ name: event.target.value })}
              onBlur={() => touch("name")}
              placeholder="Slack, Outlook, Telegram..."
            />
            {nameError ? (
              <p className="field-message is-error" id={`${ids}-name-error`}>
                {nameError}
              </p>
            ) : null}
          </div>

          <div className={`field ${urlError ? "has-error" : urlWarning ? "has-warning" : ""}`}>
            <label htmlFor={`${ids}-url`}>Web address</label>
            <input
              id={`${ids}-url`}
              type="text"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              value={form.url}
              aria-invalid={Boolean(urlError)}
              aria-describedby={urlError || urlWarning ? `${ids}-url-message` : undefined}
              onChange={(event) => update({ url: event.target.value })}
              onBlur={() => touch("url")}
              placeholder="https://app.example.com"
            />
            {urlError || urlWarning ? (
              <p className={`field-message ${urlError ? "is-error" : "is-warning"}`} id={`${ids}-url-message`}>
                {urlError || urlWarning}
              </p>
            ) : (
              <p className="field-message">Addresses without http:// or https:// use https://.</p>
            )}
          </div>

          <label className="checkbox-row modal-checkbox">
            <input
              type="checkbox"
              checked={form.isEnabled}
              onChange={(event) => update({ isEnabled: event.target.checked })}
            />
            <span>Show this app on this device</span>
          </label>

          <div className="field">
            <span className="field-label">Icon</span>
            <div className="icon-grid">
              {iconLibrary.map((icon) => (
                <button
                  key={icon.key}
                  type="button"
                  aria-pressed={form.iconSource === icon.iconSource}
                  className={`icon-option ${form.iconSource === icon.iconSource ? "selected" : ""}`}
                  onClick={() => update({ iconSource: icon.iconSource, iconKey: icon.key })}
                >
                  <img src={icon.iconSource} alt="" />
                  <span>{icon.label}</span>
                </button>
              ))}
              {form.iconSource && !isLibraryIcon ? (
                <button type="button" aria-pressed="true" className="icon-option selected">
                  <img src={form.iconSource} alt="" />
                  <span>Custom</span>
                </button>
              ) : null}
            </div>
            {canUploadIcon ? (
              <>
                <button
                  className="secondary-button upload-button"
                  onClick={upload}
                  type="button"
                  aria-describedby={`${ids}-icon-message`}
                >
                  Upload custom icon
                </button>
                {iconError ? (
                  <p key="error" className="field-message is-error" id={`${ids}-icon-message`} role="alert">
                    {iconError}
                  </p>
                ) : (
                  <p key="hint" className="field-message" id={`${ids}-icon-message`}>
                    PNG, JPEG, GIF, WebP, ICO or SVG, up to 1 MB.
                  </p>
                )}
              </>
            ) : null}
          </div>

          {actionError ? (
            <p className="field-message is-error modal-error" role="alert">
              {actionError}
            </p>
          ) : null}

          <div className="modal-actions">
            {isEditing && !isBuiltIn ? (
              <button className="danger-button" onClick={remove} type="button" disabled={busy}>
                Remove app
              </button>
            ) : (
              <span className="modal-hint">
                {isBuiltIn ? "Built-in apps can be hidden and restored later." : ""}
              </span>
            )}
            <div className="modal-actions-end">
              <button className="ghost-button" onClick={onClose} type="button">
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={!validation.valid || busy}>
                {isEditing ? "Save app" : "Add app"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
