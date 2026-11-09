// Find in page for the selected service (`services:find`). Electron-free: it decides the
// Electron options and remembers where results go.

export const FIND_TEXT_MAX_LENGTH = 500;
export const STOP_FIND_ACTIONS = Object.freeze(["clearSelection", "keepSelection", "activateSelection"]);

/**
 * One find session at a time. `request` returns null for nothing to search, else
 * { text, options, previous } where `previous` is a page whose highlights must be cleared first.
 * `findNext: true` means "next match of the same search"; a new text, page or case setting starts a
 * new session (Electron's own `findNext` option means "new session", so it is inverted here).
 */
export function createFindTracker() {
  let current = null;

  return {
    request({ contentsId, text, forward = true, findNext = false, matchCase = false, replyTo = null }) {
      const query = typeof text === "string" ? text.slice(0, FIND_TEXT_MAX_LENGTH) : "";
      if (contentsId === null || contentsId === undefined || !query) return null;
      const previous = current && current.contentsId !== contentsId ? current.contentsId : null;
      const newSession =
        findNext !== true || !current || current.contentsId !== contentsId || current.text !== query ||
        current.matchCase !== (matchCase === true);
      current = { contentsId, text: query, matchCase: matchCase === true, replyTo };
      return {
        text: query,
        options: { forward: forward !== false, findNext: newSession, matchCase: matchCase === true },
        previous
      };
    },
    /** Where a page's results go, or null when that page is not being searched. */
    replyTargetFor(contentsId) {
      return current && current.contentsId === contentsId ? current.replyTo : null;
    },
    /** Ends the session; returns the page that was searched, or null. */
    stop() {
      const contentsId = current?.contentsId ?? null;
      current = null;
      return contentsId;
    },
    forget(contentsId) {
      if (current?.contentsId === contentsId) current = null;
    }
  };
}

export const normalizeStopFindAction = (action) => (STOP_FIND_ACTIONS.includes(action) ? action : "clearSelection");
