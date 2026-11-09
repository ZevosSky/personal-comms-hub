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

/**
 * What one dock visibility pass should do. Visibility only changes through IPC and window
 * events, so there is no polling: a collapsed dock hides to the trigger unless a dock surface
 * still has focus, in which case its blur event runs the next pass.
 */
export const planDockVisibility = ({ dockModeSupported, windowMode, dockExpanded, dockSurfaceFocused }) => {
  if (!dockModeSupported || windowMode !== "dock") return "hide-all";
  if (dockExpanded) return "reveal";
  return dockSurfaceFocused ? "wait" : "collapse";
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
