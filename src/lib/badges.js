// Unread badge rule (D5): the title-parsed unread count when the page exposes one and the
// service's badge toggle is on; otherwise unseen notifications since the service was last viewed.

const toCount = (value) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
};

// Fallback for an older main process that has no runtime.unseenNotificationCounts.
export const countUnseenFromHistory = (appState) => {
  const counts = {};
  const lastSeenByService = appState?.ui?.notificationLastSeenByService ?? {};
  for (const entry of appState?.notificationHistory ?? []) {
    if (!entry?.serviceId) continue;
    const lastSeen = Date.parse(lastSeenByService[entry.serviceId] ?? "");
    if (Number.isFinite(lastSeen) && Date.parse(entry.createdAt) <= lastSeen) continue;
    counts[entry.serviceId] = (counts[entry.serviceId] ?? 0) + 1;
  }
  return counts;
};

// Returns { [serviceId]: { count, kind: "unread" | "alerts" } } for enabled services.
export const computeServiceBadges = (appState, runtime) => {
  const badges = {};
  const titleCounts = runtime?.badgeCounts ?? {};
  const unseen =
    runtime?.unseenNotificationCounts && typeof runtime.unseenNotificationCounts === "object"
      ? runtime.unseenNotificationCounts
      : countUnseenFromHistory(appState);

  for (const service of appState?.services ?? []) {
    if (!service.isEnabled) continue;
    const titleCount =
      service.notificationSettings?.badgeEnabled === false ? 0 : toCount(titleCounts[service.id]);
    badges[service.id] =
      titleCount > 0
        ? { count: titleCount, kind: "unread" }
        : { count: toCount(unseen[service.id]), kind: "alerts" };
  }
  return badges;
};

export const totalBadgeCount = (badges) =>
  Object.values(badges).reduce((sum, badge) => sum + (badge?.count ?? 0), 0);
