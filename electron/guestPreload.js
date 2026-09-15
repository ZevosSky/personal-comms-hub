const { ipcRenderer, webFrame } = require("electron");

const bridgeScript = `
  (() => {
    if (window.__commsNotificationBridgeInstalled) {
      return;
    }
    window.__commsNotificationBridgeInstalled = true;

    const OriginalNotification = window.Notification;
    if (!OriginalNotification) {
      return;
    }

    const forward = (payload) => {
      window.postMessage(
        {
          source: "comms-app-notification",
          payload
        },
        "*"
      );
    };

    const WrappedNotification = function(title, options = {}) {
      forward({
        title,
        body: options?.body || "",
        tag: options?.tag || ""
      });
      try {
        return new OriginalNotification(title, options);
      } catch {
        return { close() {} };
      }
    };

    WrappedNotification.permission = OriginalNotification.permission;
    WrappedNotification.requestPermission = (...args) => OriginalNotification.requestPermission(...args);
    WrappedNotification.prototype = OriginalNotification.prototype;

    window.Notification = WrappedNotification;
  })();
`;

window.addEventListener("DOMContentLoaded", () => {
  // Execute in the page world without inserting an inline script blocked by site CSP.
  webFrame.executeJavaScript(bridgeScript).catch(() => {});
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "comms-app-notification") {
    return;
  }

  const payload = event.data.payload ?? {};
  ipcRenderer.send("guest:notification", {
    title: String(payload.title ?? "").slice(0, 500),
    body: String(payload.body ?? "").slice(0, 4000),
    tag: String(payload.tag ?? "").slice(0, 500)
  });
});

// This isolated preload also runs in subframes. No field values or keystrokes leave
// the document; one trusted edit latches protection until main-frame navigation.
let reportedEdit = false;
const reportEdit = (event) => {
  if (reportedEdit || !event.isTrusted) return;
  const editable = event.composedPath().some((node) => {
    if (!(node instanceof Element)) return false;
    if (node.isContentEditable) return true;
    if (node.matches("textarea, select")) return !node.disabled && !node.readOnly;
    return node.matches("input") && !node.disabled && !node.readOnly &&
      !["button", "submit", "reset", "image", "hidden"].includes(node.type);
  });
  if (!editable) return;
  reportedEdit = true;
  ipcRenderer.send("guest:edited", true);
};
window.addEventListener("input", reportEdit, true);
window.addEventListener("change", reportEdit, true);
