import assert from "node:assert/strict";
import {
  applyBoundsIfChanged,
  configureUtilityWindowOnce,
  createCoalescedAsyncRunner,
  setUtilityWindowVisibility
} from "../electron/dockController.js";
import {
  BUBBLE_DEFAULT_SIZE,
  clampBubbleSizeToWorkArea,
  getBubbleBoundsForWorkArea,
  getDockBoundsForWorkArea,
  getDockModeCapabilities
} from "../electron/windowGeometry.js";

const workArea = { x: 0, y: 0, width: 1280, height: 900 };
const dockBounds = getDockBoundsForWorkArea({
  workArea,
  corner: "bottom-left",
  height: 420
});
assert.deepEqual(dockBounds, { x: 4, y: 462, width: 72, height: 420 });

const bubbleBounds = getBubbleBoundsForWorkArea({
  workArea,
  dockBounds,
  corner: "bottom-left",
  preferredSize: BUBBLE_DEFAULT_SIZE
});
assert.deepEqual(bubbleBounds, { x: 76, y: 62, width: 980, height: 820 });

for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
  const positionedDock = getDockBoundsForWorkArea({ workArea, corner, height: 420 });
  const positionedBubble = getBubbleBoundsForWorkArea({
    workArea,
    dockBounds: positionedDock,
    corner,
    preferredSize: BUBBLE_DEFAULT_SIZE
  });
  assert.ok(positionedBubble.x >= workArea.x);
  assert.ok(positionedBubble.y >= workArea.y);
  assert.ok(positionedBubble.x + positionedBubble.width <= workArea.x + workArea.width);
  assert.ok(positionedBubble.y + positionedBubble.height <= workArea.y + workArea.height);
}

const smallBubble = clampBubbleSizeToWorkArea(BUBBLE_DEFAULT_SIZE, {
  x: 0,
  y: 0,
  width: 300,
  height: 250
});
assert.deepEqual(smallBubble, { width: 220, height: 214 });
assert.deepEqual(getDockModeCapabilities("linux"), {
  dockModeSupported: false,
  dockModeUnavailableReason: "Floating dock and pop-out are temporarily unavailable on Linux. Use the full app."
});
assert.equal(getDockModeCapabilities("win32").dockModeSupported, true);

class MockWindow {
  constructor() {
    this.bounds = { x: 1, y: 2, width: 3, height: 4 };
    this.visible = false;
    this.calls = [];
  }
  isDestroyed() {
    return false;
  }
  getBounds() {
    return this.bounds;
  }
  setBounds(bounds) {
    this.calls.push("bounds");
    this.bounds = bounds;
  }
  isVisible() {
    return this.visible;
  }
  showInactive() {
    this.calls.push("showInactive");
    this.visible = true;
  }
  hide() {
    this.calls.push("hide");
    this.visible = false;
  }
  setAlwaysOnTop() {
    this.calls.push("alwaysOnTop");
  }
  setVisibleOnAllWorkspaces() {
    this.calls.push("allWorkspaces");
  }
}

const mockWindow = new MockWindow();
assert.equal(applyBoundsIfChanged(mockWindow, mockWindow.getBounds()), false);
assert.equal(applyBoundsIfChanged(mockWindow, { x: 5, y: 2, width: 3, height: 4 }), true);
assert.equal(setUtilityWindowVisibility(mockWindow, true), true);
assert.equal(setUtilityWindowVisibility(mockWindow, true), false);
assert.equal(configureUtilityWindowOnce(mockWindow), true);
assert.equal(configureUtilityWindowOnce(mockWindow), false);
assert.deepEqual(mockWindow.calls, ["bounds", "showInactive", "alwaysOnTop", "allWorkspaces"]);

let passes = 0;
let releaseFirstPass;
const firstPass = new Promise((resolve) => {
  releaseFirstPass = resolve;
});
const sync = createCoalescedAsyncRunner(async () => {
  passes += 1;
  if (passes === 1) {
    await firstPass;
  }
});
const firstRequest = sync();
await Promise.resolve();
const secondRequest = sync();
assert.equal(firstRequest, secondRequest);
releaseFirstPass();
await firstRequest;
assert.equal(passes, 2, "requests during a pass should coalesce into one serialized follow-up pass");

let reentrantPasses = 0;
let depth = 0;
let maxDepth = 0;
const reentrantSync = createCoalescedAsyncRunner(async () => {
  depth += 1;
  maxDepth = Math.max(maxDepth, depth);
  reentrantPasses += 1;
  if (reentrantPasses === 1) reentrantSync(); // Like a synchronous native show event.
  await Promise.resolve();
  depth -= 1;
});
await reentrantSync();
assert.equal(reentrantPasses, 2);
assert.equal(maxDepth, 1, "native events must not reenter a running visibility pass");

console.log("Window behavior tests passed.");
