import { Menu, Tray } from "electron";
import { trayMenuModel, trayToolTip } from "./appLifecycle.js";

/**
 * Owns the notification-area icon. The menu is rebuilt whenever what it shows changes, and its
 * actions run against the app's state at click time, never a snapshot taken when it was built.
 */
export const createTrayController = ({ getIcon, actions, onActivate, onError, platform = process.platform }) => {
  let tray = null;
  let menuKey = null;
  let toolTip = null;
  let unread = 0;

  const run = (label, task) => {
    Promise.resolve()
      .then(task)
      .catch((error) => onError(`Tray action "${label}" failed.`, error));
  };

  const applyToolTip = () => {
    const next = trayToolTip(unread);
    if (!tray || next === toolTip) return;
    toolTip = next;
    tray.setToolTip(next);
  };

  /** view: `{ windowMode, dockModeSupported }` */
  const update = (view) => {
    if (!tray) return;
    const model = trayMenuModel(view);
    const key = JSON.stringify(model);
    if (key === menuKey) return;
    menuKey = key;
    tray.setContextMenu(
      Menu.buildFromTemplate(
        model.map(({ action, ...item }) =>
          action ? { ...item, click: () => run(action, () => actions[action]?.()) } : item
        )
      )
    );
  };

  const create = (view) => {
    if (!tray) {
      try {
        tray = new Tray(getIcon());
      } catch (error) {
        // No notification area (some Linux desktops): the app still starts, without a tray.
        onError("Could not create the tray icon.", error);
        return;
      }
      if (platform === "linux") tray.setIgnoreDoubleClickEvents(true);
      tray.on("click", () => run("click", onActivate));
      if (platform !== "linux") tray.on("double-click", () => run("double-click", onActivate));
      tray.on("right-click", () => tray?.popUpContextMenu());
    }
    applyToolTip();
    update(view);
  };

  /** Shows the total unread count in the tooltip. */
  const setUnread = (count) => {
    unread = count;
    applyToolTip();
  };

  const destroy = () => {
    if (!tray) return;
    tray.destroy();
    tray = null;
    menuKey = null;
    toolTip = null;
  };

  return { create, update, setUnread, destroy, isActive: () => Boolean(tray && !tray.isDestroyed()) };
};
