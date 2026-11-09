import { useEffect, useId, useRef, useState } from "react";
import { clamp } from "../../lib/limits.js";

export function ToggleRow({ label, hint, checked, disabled = false, onChange }) {
  const id = useId();
  return (
    <div className={`setting-row ${disabled ? "is-disabled" : ""}`}>
      <span className="setting-copy">
        <label className="setting-label" htmlFor={id}>
          {label}
        </label>
        {hint ? <span className="setting-hint">{hint}</span> : null}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={Boolean(checked)}
        disabled={disabled}
        aria-checked={Boolean(checked)}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

const IDLE_COMMIT_MS = 500;

// Number field with a local draft so typing isn't clamped per keystroke. Commits (clamped) on
// blur or Enter, and after 500 ms idle when the draft is already within range.
export function DockHeightSetting({ value, limits, onCommit }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (raw, { clampValue = true } = {}) => {
    clearTimeout(timer.current);
    const number = Math.round(Number(raw));
    if (raw === "" || !Number.isFinite(number)) {
      if (clampValue) setDraft(String(value));
      return;
    }
    if (!clampValue && (number < limits.min || number > limits.max)) return;
    const next = clamp(number, limits.min, limits.max);
    if (clampValue) setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="setting-row">
      <span className="setting-copy">
        <label className="setting-label" htmlFor={id}>
          Dock height
        </label>
        <span className="setting-hint">
          {limits.min}–{limits.max} px. Drag the bubble edges to resize its page.
        </span>
      </span>
      <input
        id={id}
        className="setting-number-input"
        type="number"
        min={limits.min}
        max={limits.max}
        step="10"
        value={draft}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(event) => {
          const next = event.target.value;
          editing.current = true;
          setDraft(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(next, { clampValue: false }), IDLE_COMMIT_MS);
        }}
        onBlur={(event) => {
          editing.current = false;
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            clearTimeout(timer.current);
            setDraft(String(value));
          }
        }}
      />
    </div>
  );
}
