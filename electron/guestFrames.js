// Main-side half of the guest preload's state protocol (D17): before the memory saver puts a page
// to sleep it asks each frame that reported a draft or live capture whether that is still true.
// Electron-free: frames are passed in as { key, send } targets.

export const FRAME_QUERY_TIMEOUT_MS = 1500;

const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(1000, Math.floor(number)) : 0;
};

/** A frame's stable identity for the life of the frame (survives its navigations). */
export const frameKeyOf = (frame) => {
  try {
    if (!frame || frame.isDestroyed?.()) return null;
    return Number.isInteger(frame.frameTreeNodeId) ? frame.frameTreeNodeId : null;
  } catch {
    return null;
  }
};

export const normalizeFrameState = (payload) => ({ dirty: payload?.dirty === true, captures: count(payload?.captures) });

export function createFrameStateQuery({
  timeoutMs = FRAME_QUERY_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let sequence = 0;
  const pending = new Map(); // requestId -> { waiting: Set<key>, replies: Map, finish }

  return {
    /**
     * Sends `guest:query-state` to each target and resolves with Map<key, { dirty, captures } | null>:
     * null when the frame is gone, no entry when it did not answer in time.
     */
    query(targets = []) {
      return new Promise((resolve) => {
        sequence += 1;
        const requestId = `frames-${sequence}`;
        const replies = new Map();
        const waiting = new Set();
        for (const { key, send } of targets) {
          if (typeof send !== "function") {
            replies.set(key, null);
            continue;
          }
          try {
            send("guest:query-state", requestId);
            waiting.add(key);
          } catch {
            replies.set(key, null);
          }
        }
        if (!waiting.size) {
          resolve(replies);
          return;
        }
        let timer = null;
        const finish = () => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          clearTimeoutFn(timer);
          resolve(replies);
        };
        pending.set(requestId, { waiting, replies, finish });
        timer = setTimeoutFn(finish, timeoutMs);
        timer?.unref?.();
      });
    },
    /** A `guest:state` reply from the frame with this key. Returns true when it answered a query. */
    receive(key, payload) {
      const request = pending.get(payload?.requestId);
      if (!request || key === null || !request.waiting.has(key)) return false;
      request.waiting.delete(key);
      request.replies.set(key, normalizeFrameState(payload));
      if (!request.waiting.size) request.finish();
      return true;
    },
    dispose() {
      for (const request of [...pending.values()]) request.finish();
    }
  };
}

/** Query targets for the given frame keys inside a page (WebContents-like object). */
export const frameTargetsFor = (contents, keys) => {
  let frames = [];
  try {
    frames = contents && !contents.isDestroyed() ? contents.mainFrame.framesInSubtree : [];
  } catch {
    frames = [];
  }
  return keys.map((key) => {
    const frame = frames.find((candidate) => frameKeyOf(candidate) === key);
    return { key, send: frame && !frame.detached ? (...args) => frame.send(...args) : null };
  });
};
