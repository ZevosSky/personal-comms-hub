import { equalBounds } from "./windowGeometry.js";

const configuredUtilityWindows = new WeakSet();

/** Coalesces bursts of async window work into serialized passes. */
export const createCoalescedAsyncRunner = (task) => {
  let pending = false;
  let active = null;

  return () => {
    pending = true;
    if (active) {
      return active;
    }

    // Assign active before task can synchronously emit a window event and reenter us.
    active = Promise.resolve().then(async () => {
      do {
        pending = false;
        await task();
      } while (pending);
    }).finally(() => {
      active = null;
    });

    return active;
  };
};

export const applyBoundsIfChanged = (windowInstance, bounds) => {
  if (!windowInstance || windowInstance.isDestroyed() || equalBounds(windowInstance.getBounds(), bounds)) {
    return false;
  }

  windowInstance.setBounds(bounds);
  return true;
};

export const configureUtilityWindowOnce = (windowInstance) => {
  if (!windowInstance || windowInstance.isDestroyed() || configuredUtilityWindows.has(windowInstance)) {
    return false;
  }

  windowInstance.setAlwaysOnTop(true, "floating");
  windowInstance.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  configuredUtilityWindows.add(windowInstance);
  return true;
};

export const setUtilityWindowVisibility = (windowInstance, visible) => {
  if (!windowInstance || windowInstance.isDestroyed() || windowInstance.isVisible() === visible) {
    return false;
  }

  if (visible) {
    windowInstance.showInactive();
  } else {
    windowInstance.hide();
  }
  return true;
};
