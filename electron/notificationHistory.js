// In-memory notification history (D6): a bounded ring buffer of recent notifications, plus per-service
// unseen counters kept apart from the ring so a busy app cannot evict another app's unseen count.
import { randomUUID } from "node:crypto";
import { NOTIFICATION_HISTORY_LIMIT } from "./limits.js";

const text = (value, max) => String(value ?? "").slice(0, max);

export function createNotificationHistory({
  limit = NOTIFICATION_HISTORY_LIMIT,
  now = Date.now,
  createId = randomUUID
} = {}) {
  let entries = []; // newest first
  const unseen = new Map(); // serviceId -> notifications since the service was last viewed

  return {
    record({ serviceId, serviceName, source, title, body }) {
      const entry = Object.freeze({
        id: createId(),
        createdAt: new Date(now()).toISOString(),
        serviceId: text(serviceId, 200),
        serviceName: text(serviceName, 200),
        source: text(source || "activity", 40),
        title: text(title, 300),
        body: text(body, 1000)
      });
      entries = [entry, ...entries].slice(0, Math.max(1, limit));
      unseen.set(entry.serviceId, (unseen.get(entry.serviceId) ?? 0) + 1);
      return entry;
    },
    list: () => entries,
    hasUnseen: (serviceId) => (unseen.get(serviceId) ?? 0) > 0,
    /** Returns true only when something was actually unseen, so callers can skip broadcasts. */
    markSeen(serviceId) {
      if (!serviceId || !unseen.get(serviceId)) return false;
      unseen.delete(serviceId);
      return true;
    },
    unseenCounts: () => Object.fromEntries(unseen),
    clear() {
      const hadEntries = entries.length > 0 || unseen.size > 0;
      entries = [];
      unseen.clear();
      return hadEntries;
    },
    forgetService(serviceId) {
      const before = entries.length;
      entries = entries.filter((entry) => entry.serviceId !== serviceId);
      const hadUnseen = unseen.delete(serviceId);
      return entries.length !== before || hadUnseen;
    }
  };
}
