// Ranges come from state.limits (main owns them); these are fallbacks for an older main process.
const DEFAULT_LIMITS = {
  zoom: { min: 0.5, max: 2, step: 0.1 },
  dockHeight: { min: 280, max: 720 },
  memorySaverTimeoutOptions: [5, 10, 15, 30, 60]
};

const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export const getLimits = (state) => {
  const limits = state?.limits ?? {};
  const zoom = limits.zoom ?? {};
  const dockHeight = limits.dockHeight ?? {};
  const options = Array.isArray(limits.memorySaverTimeoutOptions)
    ? limits.memorySaverTimeoutOptions.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return {
    zoom: {
      min: finite(zoom.min, DEFAULT_LIMITS.zoom.min),
      max: finite(zoom.max, DEFAULT_LIMITS.zoom.max),
      step: finite(zoom.step, DEFAULT_LIMITS.zoom.step) || DEFAULT_LIMITS.zoom.step
    },
    dockHeight: {
      min: finite(dockHeight.min, DEFAULT_LIMITS.dockHeight.min),
      max: finite(dockHeight.max, DEFAULT_LIMITS.dockHeight.max)
    },
    memorySaverTimeoutOptions: options.length ? options : DEFAULT_LIMITS.memorySaverTimeoutOptions
  };
};

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const stepZoom = (factor, direction, zoomLimits) => {
  const next = Math.round((factor + direction * zoomLimits.step) * 100) / 100;
  return clamp(next, zoomLimits.min, zoomLimits.max);
};
