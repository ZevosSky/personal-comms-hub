// Shared limits for main, the config store and the service manager. Electron-free.
// The renderer receives the subset it needs through `state.limits`.

export const ZOOM_LIMITS = Object.freeze({ min: 0.5, max: 2, step: 0.1, default: 1 });
export const DOCK_HEIGHT_LIMITS = Object.freeze({ min: 280, max: 720, default: 420 });
export const DOCK_CORNERS = Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right"]);
export const DEFAULT_DOCK_CORNER = "bottom-left";
export const WINDOW_MODES = Object.freeze(["full", "dock"]);
export const MEMORY_SAVER_TIMEOUT_OPTIONS = Object.freeze([5, 10, 15, 30, 60]);
export const DEFAULT_MEMORY_SAVER_TIMEOUT_MINUTES = 10;
export const NOTIFICATION_HISTORY_LIMIT = 80;
export const SERVICE_NAME_MAX_LENGTH = 80;
export const MAIN_WINDOW_MIN_SIZE = Object.freeze({ width: 800, height: 560 });
export const MAIN_WINDOW_DEFAULT_SIZE = Object.freeze({ width: 1440, height: 960 });

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const clampZoomFactor = (value) => {
  const factor = finite(value ?? ZOOM_LIMITS.default);
  return factor === null ? ZOOM_LIMITS.default : Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, factor));
};

export const clampDockHeight = (value) => {
  const height = finite(value);
  return height === null
    ? DOCK_HEIGHT_LIMITS.default
    : Math.min(DOCK_HEIGHT_LIMITS.max, Math.max(DOCK_HEIGHT_LIMITS.min, Math.round(height)));
};

export const normalizeDockCorner = (value) => (DOCK_CORNERS.includes(value) ? value : DEFAULT_DOCK_CORNER);

export const normalizeMemorySaverTimeout = (value) => {
  const minutes = finite(value);
  return MEMORY_SAVER_TIMEOUT_OPTIONS.includes(minutes) ? minutes : DEFAULT_MEMORY_SAVER_TIMEOUT_MINUTES;
};

export const isHttpUrl = (value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

export const rendererLimits = Object.freeze({
  zoom: Object.freeze({ min: ZOOM_LIMITS.min, max: ZOOM_LIMITS.max, step: ZOOM_LIMITS.step }),
  dockHeight: Object.freeze({ min: DOCK_HEIGHT_LIMITS.min, max: DOCK_HEIGHT_LIMITS.max }),
  memorySaverTimeoutOptions: MEMORY_SAVER_TIMEOUT_OPTIONS
});
