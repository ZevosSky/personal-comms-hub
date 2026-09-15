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
