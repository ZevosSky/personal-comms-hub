import { MAIN_WINDOW_DEFAULT_SIZE, MAIN_WINDOW_MIN_SIZE } from "./limits.js";

export const DOCK_WINDOW_SIZE = { width: 72, height: 420 };
export const BUBBLE_DEFAULT_SIZE = { width: 980, height: 820 };
export const BUBBLE_MINIMUM_SIZE = { width: 560, height: 520 };
export const BUBBLE_MAXIMUM_SIZE = { width: 3840, height: 2160 };
export const WINDOW_SIDE_INSET = 4;
export const WINDOW_VERTICAL_INSET = 18;

const finiteInteger = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : fallback;
};

export const equalBounds = (left, right) =>
  Boolean(
    left &&
      right &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height
  );

export const getDockModeCapabilities = (platform) => ({
  dockModeSupported: platform !== "linux",
  dockModeUnavailableReason:
    platform === "linux"
      ? "Floating dock and pop-out are temporarily unavailable on Linux. Use the full app."
      : null
});

export const normalizePreferredBubbleSize = (size) => {
  const candidate = size ?? {};
  return {
    width: Math.min(
      BUBBLE_MAXIMUM_SIZE.width,
      Math.max(BUBBLE_MINIMUM_SIZE.width, finiteInteger(candidate.width, BUBBLE_DEFAULT_SIZE.width))
    ),
    height: Math.min(
      BUBBLE_MAXIMUM_SIZE.height,
      Math.max(BUBBLE_MINIMUM_SIZE.height, finiteInteger(candidate.height, BUBBLE_DEFAULT_SIZE.height))
    )
  };
};

export const getBubbleConstraints = (workArea, dockWidth = DOCK_WINDOW_SIZE.width) => {
  const availableWidth = Math.max(1, Math.round(workArea.width - dockWidth - WINDOW_SIDE_INSET * 2));
  const availableHeight = Math.max(1, Math.round(workArea.height - WINDOW_VERTICAL_INSET * 2));

  return {
    minWidth: Math.min(BUBBLE_MINIMUM_SIZE.width, availableWidth),
    minHeight: Math.min(BUBBLE_MINIMUM_SIZE.height, availableHeight),
    maxWidth: availableWidth,
    maxHeight: availableHeight
  };
};

export const clampBubbleSizeToWorkArea = (preferredSize, workArea, dockWidth = DOCK_WINDOW_SIZE.width) => {
  const preferred = normalizePreferredBubbleSize(preferredSize);
  const constraints = getBubbleConstraints(workArea, dockWidth);

  return {
    width: Math.min(constraints.maxWidth, Math.max(constraints.minWidth, preferred.width)),
    height: Math.min(constraints.maxHeight, Math.max(constraints.minHeight, preferred.height))
  };
};

export const getDockBoundsForWorkArea = ({ workArea, corner, height, dock = DOCK_WINDOW_SIZE }) => {
  const dockHeight = Math.min(
    Math.max(1, Math.round(workArea.height - WINDOW_VERTICAL_INSET * 2)),
    Math.max(1, Math.round(height))
  );
  const dockWidth = Math.min(Math.max(1, dock.width), Math.max(1, Math.round(workArea.width - WINDOW_SIDE_INSET * 2)));
  const rightAnchored = corner === "top-right" || corner === "bottom-right";
  const topAnchored = corner === "top-left" || corner === "top-right";

  return {
    width: dockWidth,
    height: dockHeight,
    x: rightAnchored
      ? workArea.x + workArea.width - dockWidth - WINDOW_SIDE_INSET
      : workArea.x + WINDOW_SIDE_INSET,
    y: topAnchored
      ? workArea.y + WINDOW_VERTICAL_INSET
      : workArea.y + workArea.height - dockHeight - WINDOW_VERTICAL_INSET
  };
};

export const getBubbleBoundsForWorkArea = ({ workArea, dockBounds, corner, preferredSize }) => {
  const bubble = clampBubbleSizeToWorkArea(preferredSize, workArea, dockBounds.width);
  const rightAnchored = corner === "top-right" || corner === "bottom-right";
  const topAnchored = corner === "top-left" || corner === "top-right";

  return {
    ...bubble,
    x: rightAnchored ? dockBounds.x - bubble.width : dockBounds.x + dockBounds.width,
    y: topAnchored
      ? workArea.y + WINDOW_VERTICAL_INSET
      : workArea.y + workArea.height - bubble.height - WINDOW_VERTICAL_INSET
  };
};

const maxWindowCoordinate = 100000;
const maxWindowExtent = 20000;
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isRect = (rect) =>
  Boolean(rect) && [rect.x, rect.y, rect.width, rect.height].every(isNumber) && rect.width > 0 && rect.height > 0;

/** Saved main-window placement `{ x, y, width, height, isMaximized }`, or null when unusable. */
export const normalizeWindowState = (raw) => {
  if (!raw || typeof raw !== "object" || !isRect(raw)) return null;
  const [x, y, width, height] = [raw.x, raw.y, raw.width, raw.height].map(Math.round);
  if (Math.abs(x) > maxWindowCoordinate || Math.abs(y) > maxWindowCoordinate) return null;
  return {
    x,
    y,
    width: Math.min(maxWindowExtent, Math.max(MAIN_WINDOW_MIN_SIZE.width, width)),
    height: Math.min(maxWindowExtent, Math.max(MAIN_WINDOW_MIN_SIZE.height, height)),
    isMaximized: raw.isMaximized === true
  };
};

const overlapArea = (a, b) => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
};

// Shrinks bounds to the work area (never below the minimum size) and moves them fully inside it.
const fitInside = (bounds, area, minSize) => {
  const width = Math.max(minSize.width, Math.min(bounds.width, area.width));
  const height = Math.max(minSize.height, Math.min(bounds.height, area.height));
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height
  };
};

/**
 * Where to create the main window (D18). Saved bounds are kept when they mostly lie on one current
 * display, fitted inside that display's work area; otherwise the default size is centred on the
 * primary display. Returns `{ x, y, width, height, isMaximized }`.
 */
export const restoreWindowBounds = ({
  saved,
  workAreas = [],
  primaryWorkArea,
  defaultSize = MAIN_WINDOW_DEFAULT_SIZE,
  minSize = MAIN_WINDOW_MIN_SIZE
}) => {
  const state = normalizeWindowState(saved);
  const areas = workAreas.filter(isRect);
  const isMaximized = state?.isMaximized ?? false;

  if (state) {
    let best = null;
    let bestOverlap = 0;
    for (const area of areas) {
      const overlap = overlapArea(state, area);
      if (overlap > bestOverlap) {
        best = area;
        bestOverlap = overlap;
      }
    }
    // "Half" of the smaller of the two, so a window larger than the display can still qualify.
    if (best && bestOverlap * 2 >= Math.min(state.width * state.height, best.width * best.height)) {
      return { ...fitInside(state, best, minSize), isMaximized };
    }
  }

  const primary = isRect(primaryWorkArea) ? primaryWorkArea : areas[0];
  if (!primary) return { width: defaultSize.width, height: defaultSize.height, isMaximized };
  const size = fitInside({ x: primary.x, y: primary.y, ...defaultSize }, primary, minSize);
  return {
    ...size,
    x: Math.round(primary.x + Math.max(0, primary.width - size.width) / 2),
    y: Math.round(primary.y + Math.max(0, primary.height - size.height) / 2),
    isMaximized
  };
};
