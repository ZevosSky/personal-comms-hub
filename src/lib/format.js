// Pure label and number formatting helpers (no DOM, no bridge).

export const DEFAULT_MEMORY_SAVER_MINUTES = 10;

const PROTECTION_LABELS = {
  edited: "unsent draft",
  media: "playing media",
  beforeunload: "unsaved changes",
  unresponsive: "page busy",
  closing: "closing",
  popup: "popup open",
  capture: "in a call or sharing"
};

const LIVE_STATUSES = new Set(["active", "idle", "protected"]);

export const formatMemory = (kilobytes) => {
  const kb = Number(kilobytes);
  if (!Number.isFinite(kb) || kb < 0) return "—";
  const mb = kb / 1024;
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }
  return `${Math.max(0, Math.round(mb))} MB`;
};

export const formatCpu = (percent) => {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
};

export const formatBadgeCount = (count) => (count > 99 ? "99+" : String(count));

export const getHostname = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export const isRuntimeLive = (runtime) =>
  Boolean(runtime?.webContentsId) || LIVE_STATUSES.has(runtime?.status) || runtime?.status === "loading";

// Coarse state used for rail cues and status chips.
// connected | loading | asleep | error | offline | closing | hidden | unknown
export const getServiceCondition = (service, runtime) => {
  if (!service?.isEnabled || runtime?.status === "disabled") return "hidden";
  if (!runtime) return "unknown";
  if (runtime.retryAt && !LIVE_STATUSES.has(runtime.status)) return "offline";
  switch (runtime.status) {
    case "error":
      return "error";
    case "loading":
      return "loading";
    case "closing":
      return "closing";
    case "sleeping":
    case "unloaded":
      return "asleep";
    case "active":
    case "idle":
    case "protected":
      return "connected";
    default:
      return runtime.webContentsId ? "connected" : "asleep";
  }
};

export const getMemoryStateLabel = (service, ui, runtime) => {
  if (!service) return "Idle";
  const condition = getServiceCondition(service, runtime);
  switch (condition) {
    case "hidden":
      return "Hidden on this device";
    case "offline":
      return "Offline — retrying";
    case "error":
      return "Load failed";
    case "closing":
      return "Going to sleep…";
    case "loading":
      return "Loading…";
    case "asleep":
      if (runtime?.manuallySlept) return "Asleep (put to sleep)";
      return runtime?.status === "unloaded" ? "Not loaded yet" : "Sleeping";
    case "unknown":
      return "Starting…";
    default:
      break;
  }
  if (runtime?.status === "active") return "Open now";
  const reasonLabel = PROTECTION_LABELS[runtime?.protectionReason];
  if (reasonLabel) return `Kept awake: ${reasonLabel}`;
  if (service.keepAliveInBackground) return "Kept alive";
  if (ui?.memorySaverEnabled === false) return "Kept loaded";
  const minutes = Number(ui?.memorySaverTimeoutMinutes) || DEFAULT_MEMORY_SAVER_MINUTES;
  return `Sleeps after ${minutes} min`;
};

export const getConditionTone = (condition) => {
  switch (condition) {
    case "connected":
      return "ok";
    case "error":
      return "error";
    case "offline":
    case "loading":
    case "closing":
      return "warn";
    default:
      return "muted";
  }
};

const describeBadge = (badge) => {
  if (!badge?.count) return "";
  const label = formatBadgeCount(badge.count);
  return badge.kind === "unread"
    ? `${label} unread`
    : `${label} new ${badge.count === 1 ? "alert" : "alerts"}`;
};

// Tooltip / accessible name for a rail button, e.g. "Slack — sleeping (alerts paused). Click to wake."
export const describeRailService = (service, runtime, badge, { isActive = false } = {}) => {
  const parts = [];
  const badgeText = describeBadge(badge);
  if (badgeText) parts.push(badgeText);
  const condition = getServiceCondition(service, runtime);
  let suffix = "";
  switch (condition) {
    case "asleep":
      parts.push(
        runtime?.status === "unloaded"
          ? "not loaded (alerts paused)"
          : runtime?.manuallySlept
            ? "put to sleep (alerts paused)"
            : "sleeping (alerts paused)"
      );
      suffix = isActive ? "" : runtime?.status === "unloaded" ? " Click to load." : " Click to wake.";
      break;
    case "loading":
      parts.push("loading…");
      break;
    case "closing":
      parts.push("going to sleep");
      break;
    case "error":
      parts.push("failed to load");
      suffix = " Click to open and retry.";
      break;
    case "offline":
      parts.push("offline, retrying");
      break;
    default:
      break;
  }
  const head = parts.length ? `${service.name} — ${parts.join(", ")}` : service.name;
  return suffix ? `${head}.${suffix}` : head;
};
