// Registers IPC channels that only Comms Hub's own shell pages may use. Electron-free: ipcMain and
// the sender test are injected. Guest channels (guest:*) are registered directly in main.js.

export const UNTRUSTED_SENDER_MESSAGE = "This request did not come from a Comms Hub window.";

export function createShellIpc({ ipcMain, isTrustedSender, onRejected = () => {} }) {
  const trusted = (channel, event) => {
    let ok = false;
    try {
      ok = isTrustedSender(event) === true;
    } catch {
      ok = false;
    }
    if (!ok) onRejected(channel, event);
    return ok;
  };

  return {
    /** ipcMain.handle for shell senders only; anything else is rejected before the handler runs. */
    handle(channel, handler) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!trusted(channel, event)) throw new Error(UNTRUSTED_SENDER_MESSAGE);
        return handler(event, ...args);
      });
    },
    /** ipcMain.on for shell senders only; anything else is dropped. */
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (trusted(channel, event)) listener(event, ...args);
      });
    }
  };
}
