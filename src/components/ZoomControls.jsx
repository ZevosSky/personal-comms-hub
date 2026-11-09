import { stepZoom } from "../lib/limits.js";

export function ZoomControls({ service, limits, onChange, className = "" }) {
  const factor = Number(service?.zoomFactor) || 1;
  const percent = Math.round(factor * 100);
  const change = (next) => {
    if (service && next !== factor) onChange(service.id, next);
  };
  return (
    <div className={`zoom-controls ${className}`} role="group" aria-label="Page zoom">
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={!service || factor <= limits.min}
        onClick={() => change(stepZoom(factor, -1, limits))}
      >
        −
      </button>
      <button
        type="button"
        className="zoom-percentage"
        aria-label={`Zoom ${percent}%. Reset to 100%`}
        title="Reset to 100%"
        disabled={!service || factor === 1}
        onClick={() => change(1)}
      >
        {percent}%
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={!service || factor >= limits.max}
        onClick={() => change(stepZoom(factor, 1, limits))}
      >
        +
      </button>
    </div>
  );
}
