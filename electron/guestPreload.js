import { ipcRenderer } from "electron";

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
  const script = document.createElement("script");
  script.textContent = bridgeScript;
  document.documentElement.appendChild(script);
  script.remove();
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "comms-app-notification") {
    return;
  }

  const payload = event.data.payload ?? {};
  ipcRenderer.sendToHost("comms-app-notification", payload);
});
