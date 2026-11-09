// Pure (Electron-free) model for the persisted config: built-in definitions, normalization,
// the persisted form, one-time migration and the immutable state snapshot sent to renderers.
import { getDockModeCapabilities, normalizePreferredBubbleSize, normalizeWindowState } from "./windowGeometry.js";
import {
  DEFAULT_MEMORY_SAVER_TIMEOUT_MINUTES,
  SERVICE_NAME_MAX_LENGTH,
  WINDOW_MODES,
  clampDockHeight,
  clampZoomFactor,
  isHttpUrl,
  normalizeDockCorner,
  normalizeMemorySaverTimeout,
  rendererLimits
} from "./limits.js";

export const CONFIG_VERSION = 2;

const svgToDataUrl = (svg) =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

// Fixed Chrome/135 strings that earlier builds stored for Teams and WeChat. Every guest now gets
// the clean Chrome user agent main derives from Electron's (D15), so these mean "no override".
const legacyUserAgents = new Set([
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
]);

const getServiceCompatibilityOverrides = (url) => {
  try {
    const hostname = new URL(url ?? "").hostname.toLowerCase();
    const normalizedHostname = hostname.startsWith("www.") ? hostname.slice(4) : hostname;

    if (normalizedHostname === "web.wechat.com" || normalizedHostname === "wx.qq.com") {
      return {
        useDefaultSession: true,
        sessionPartition: null
      };
    }
  } catch {
    return {};
  }

  return {};
};

const builtinIcons = {
  gmail: svgToDataUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#fff7ed'/><path d='M12 20l20 16 20-16v24a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4z' fill='#ea4335'/><path d='M12 20a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4L32 36z' fill='#fbbc04'/><path d='M12 20l20 15 20-15v24a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4z' fill='none' stroke='#c2410c' stroke-width='2.5' stroke-linejoin='round'/></svg>"
  ),
  discord: svgToDataUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#5865f2'/><path d='M45.2 19.8a30.6 30.6 0 0 0-7.7-2.4l-.4.8a28.8 28.8 0 0 1 7 2.4 24.4 24.4 0 0 0-24.2 0 28.8 28.8 0 0 1 7-2.4l-.4-.8a30.6 30.6 0 0 0-7.7 2.4C14 27 12.7 34 13.4 40.8a31 31 0 0 0 9.5 4.8l2-3.2a20.3 20.3 0 0 1-3.1-1.5l.8-.6a21.8 21.8 0 0 0 18.8 0l.8.6a20.3 20.3 0 0 1-3.1 1.5l2 3.2a31 31 0 0 0 9.5-4.8c.9-7.8-1.5-14.7-5.4-21zm-17 17.2c-1.8 0-3.3-1.7-3.3-3.8s1.5-3.8 3.3-3.8 3.4 1.7 3.3 3.8c0 2.1-1.5 3.8-3.3 3.8zm7.6 0c-1.8 0-3.3-1.7-3.3-3.8s1.5-3.8 3.3-3.8 3.4 1.7 3.3 3.8c0 2.1-1.5 3.8-3.3 3.8z' fill='#fff'/></svg>"
  ),
  messenger: svgToDataUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop offset='0%' stop-color='#00b2ff'/><stop offset='100%' stop-color='#006aff'/></linearGradient></defs><rect width='64' height='64' rx='18' fill='url(#g)'/><path d='M32 15C21.5 15 13 22.7 13 32.3c0 5.5 2.8 10.4 7.1 13.6v6.8l6.6-3.7c1.7.5 3.5.7 5.3.7 10.5 0 19-7.7 19-17.3S42.5 15 32 15zm2.1 22.9-5.2-5.5-10.2 5.5L30 25.8l5.1 5.5 10.3-5.5z' fill='#fff'/></svg>"
  ),
  slack: svgToDataUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#ffffff'/><path d='M26 13a5 5 0 1 1 10 0v8H26a4 4 0 0 1 0-8z' fill='#36c5f0'/><path d='M26 26v12a5 5 0 1 1-10 0V26h10z' fill='#2eb67d'/><path d='M13 38a5 5 0 1 1 0-10h8v10a4 4 0 0 1-8 0z' fill='#2eb67d'/><path d='M26 38a5 5 0 1 1 10 0v13a5 5 0 1 1-10 0V38z' fill='#ecb22e'/><path d='M38 51a5 5 0 1 1-10 0v-8h10a4 4 0 0 1 0 8z' fill='#ecb22e'/><path d='M38 38V26a5 5 0 1 1 10 0v12H38z' fill='#e01e5a'/><path d='M51 26a5 5 0 1 1 0 10h-8V26a4 4 0 0 1 8 0z' fill='#e01e5a'/><path d='M38 26a5 5 0 1 1-10 0V13a5 5 0 1 1 10 0v13z' fill='#36c5f0'/></svg>"
  ),
  teams: svgToDataUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#4f52b2'/><rect x='14' y='19' width='22' height='26' rx='5' fill='#7b83eb'/><circle cx='45' cy='24' r='7' fill='#8b92f7'/><path d='M24 27h10v4h-3v11h-4V31h-3z' fill='#fff'/><path d='M41 32h9a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-9z' fill='#6369d1'/></svg>"
  ),
  globe: svgToDataUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='18' fill='#0f172a'/><circle cx='32' cy='32' r='18' fill='none' stroke='#93c5fd' stroke-width='3'/><path d='M14 32h36M32 14c5 5 8 11.8 8 18s-3 13-8 18c-5-5-8-11.8-8-18s3-13 8-18z' fill='none' stroke='#93c5fd' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/></svg>"
  )
};

const defaultNotificationSettings = Object.freeze({
  desktopEnabled: true,
  badgeEnabled: true,
  captureWebNotifications: true
});

const builtIn = (id, name, url, extra = {}) => ({
  id,
  name,
  url,
  iconSource: builtinIcons[id],
  iconKey: id,
  isBuiltIn: true,
  isEnabled: true,
  sessionPartition: `persist:service-${id}`,
  supportsBadgeDetection: true,
  keepAliveInBackground: false,
  notificationSettings: defaultNotificationSettings,
  ...extra
});

export const builtInServices = Object.freeze([
  builtIn("gmail", "Gmail", "https://mail.google.com/mail/u/0/#inbox"),
  builtIn("discord", "Discord", "https://discord.com/app"),
  builtIn("messenger", "Messenger", "https://www.facebook.com/messages/"),
  // Slack's page title never carries an unread count, so its badge comes from notifications.
  builtIn("slack", "Slack", "https://app.slack.com/client", { supportsBadgeDetection: false }),
  builtIn("teams", "Teams", "https://teams.microsoft.com/v2/")
].map((service) => Object.freeze(service)));

const builtInById = new Map(builtInServices.map((service) => [service.id, service]));

// URLs that earlier builds stored for built-ins. They count as "not customised".
const historicalBuiltInUrls = {
  messenger: ["https://www.messenger.com/", "https://messenger.com/"]
};

// Other sites a built-in app is served from (Teams moves between its Microsoft domains).
const builtInSiteAliases = {
  messenger: ["https://www.messenger.com/"],
  teams: ["https://teams.cloud.microsoft/", "https://teams.live.com/"]
};

/**
 * URLs whose sites count as a built-in app's own (D10: camera/microphone without a prompt, and
 * notifications): its default address plus fixed aliases, also when the user changed its address.
 * Custom apps have none; their own address and where it lands are added by the caller.
 */
export const siteAliasesFor = (service) => {
  const builtin = service?.isBuiltIn === true ? builtInById.get(service.id) : null;
  return builtin ? [builtin.url, ...(builtInSiteAliases[builtin.id] ?? [])] : [];
};

// Only these fields of a built-in belong to the user and are persisted (when they differ
// from the definition). Everything else (userAgent, supportsBadgeDetection, sessionPartition,
// useDefaultSession, isBuiltIn) always comes from the definition above.
const userOwnedBuiltInFields = [
  "name",
  "url",
  "isEnabled",
  "iconSource",
  "iconKey",
  "zoomFactor",
  "keepAliveInBackground",
  "notificationSettings"
];

export const iconLibrary = Object.freeze([
  { key: "gmail", label: "Gmail", iconSource: builtinIcons.gmail },
  { key: "discord", label: "Discord", iconSource: builtinIcons.discord },
  { key: "messenger", label: "Messenger", iconSource: builtinIcons.messenger },
  { key: "slack", label: "Slack", iconSource: builtinIcons.slack },
  { key: "teams", label: "Teams", iconSource: builtinIcons.teams },
  { key: "globe", label: "Generic Web App", iconSource: builtinIcons.globe }
].map((icon) => Object.freeze(icon)));

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const booleanOr = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const nonEmptyString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

export const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const sameValue = (left, right) =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

export const normalizeNotificationSettings = (settings) => {
  const source = isPlainObject(settings) ? settings : {};
  return {
    desktopEnabled: booleanOr(source.desktopEnabled, true),
    badgeEnabled: booleanOr(source.badgeEnabled, true),
    captureWebNotifications: booleanOr(source.captureWebNotifications, true)
  };
};

const normalizeName = (...candidates) => {
  const name = candidates.map(nonEmptyString).find(Boolean) ?? "Untitled App";
  return name.slice(0, SERVICE_NAME_MAX_LENGTH);
};

const isHistoricalUrl = (id, url) => historicalBuiltInUrls[id]?.includes(url) ?? false;

// A non-http(s) URL never replaces a valid one; it is kept only when nothing valid exists,
// so the service shows a load error instead of silently pointing somewhere else.
const pickUrl = (id, ...candidates) => {
  const trimmed = candidates.map(nonEmptyString).filter(Boolean);
  return trimmed.find((url) => isHttpUrl(url) && !isHistoricalUrl(id, url)) ?? trimmed[0] ?? "";
};

// Stored partitions are kept verbatim (changing one would sign the user out of that app).
const isValidPartition = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);

const normalizeBuiltInService = (builtin, service, existing) => {
  const pick = (key) => service[key] ?? existing?.[key];
  return {
    id: builtin.id,
    name: normalizeName(service.name, existing?.name, builtin.name),
    url: pickUrl(builtin.id, service.url, existing?.url, builtin.url),
    iconSource: nonEmptyString(service.iconSource) ?? nonEmptyString(existing?.iconSource) ?? builtin.iconSource,
    iconKey: nonEmptyString(pick("iconKey")) ?? builtin.iconKey,
    isBuiltIn: true,
    isEnabled: booleanOr(pick("isEnabled"), builtin.isEnabled),
    sessionPartition: builtin.useDefaultSession ? null : builtin.sessionPartition,
    supportsBadgeDetection: builtin.supportsBadgeDetection,
    keepAliveInBackground: booleanOr(pick("keepAliveInBackground"), builtin.keepAliveInBackground),
    zoomFactor: clampZoomFactor(pick("zoomFactor")),
    userAgent: builtin.userAgent ?? null,
    useDefaultSession: builtin.useDefaultSession ?? false,
    notificationSettings: normalizeNotificationSettings(pick("notificationSettings") ?? builtin.notificationSettings)
  };
};

const normalizeCustomService = (id, service, existing) => {
  const pick = (key) => service[key] ?? existing?.[key];
  const url = pickUrl(id, service.url, existing?.url);
  const compatibility = getServiceCompatibilityOverrides(url);
  const useDefaultSession = compatibility.useDefaultSession ?? pick("useDefaultSession") === true;
  const storedPartition = [service.sessionPartition, existing?.sessionPartition].find(isValidPartition);
  const storedUserAgent = nonEmptyString(pick("userAgent"));
  const userAgent = legacyUserAgents.has(storedUserAgent) ? null : storedUserAgent;

  return {
    id,
    name: normalizeName(service.name, existing?.name),
    url,
    iconSource: nonEmptyString(service.iconSource) ?? nonEmptyString(existing?.iconSource) ?? builtinIcons.globe,
    iconKey: nonEmptyString(pick("iconKey")) ?? "globe",
    isBuiltIn: false,
    isEnabled: booleanOr(pick("isEnabled"), true),
    sessionPartition: useDefaultSession ? null : storedPartition ?? `persist:service-${id}`,
    supportsBadgeDetection: booleanOr(pick("supportsBadgeDetection"), true),
    keepAliveInBackground: booleanOr(pick("keepAliveInBackground"), false),
    zoomFactor: clampZoomFactor(pick("zoomFactor")),
    userAgent: userAgent ?? null,
    useDefaultSession,
    notificationSettings: normalizeNotificationSettings(pick("notificationSettings"))
  };
};

/** Normalizes one service. Built-in definitions own their code-owned fields (D15). */
export const normalizeService = (service = {}, existing = null) => {
  const source = isPlainObject(service) ? service : {};
  const id = String(source.id ?? existing?.id ?? "");
  const builtin = builtInById.get(id);
  return builtin
    ? normalizeBuiltInService(builtin, source, existing)
    : normalizeCustomService(id, source, existing);
};

/** Stored order first, then any built-in the stored list does not mention. */
export const normalizeServiceList = (stored) => {
  const seen = new Set();
  const services = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    const id = isPlainObject(entry) && typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    services.push(normalizeService({ ...entry, id }));
  }
  for (const builtin of builtInServices) {
    if (!seen.has(builtin.id)) services.push(normalizeService({ id: builtin.id }));
  }
  return services;
};

const pristineBuiltIns = new Map(
  builtInServices.map((builtin) => [builtin.id, normalizeService({ id: builtin.id })])
);

/** The persisted form: built-ins keep only user-owned fields that differ from the definition. */
export const toPersistedService = (service) => {
  const pristine = pristineBuiltIns.get(service.id);
  if (!pristine) {
    const { isBuiltIn: _isBuiltIn, ...custom } = service;
    return custom;
  }

  const persisted = { id: service.id };
  for (const key of userOwnedBuiltInFields) {
    if (!sameValue(service[key], pristine[key])) persisted[key] = service[key];
  }
  return persisted;
};

export const defaultUi = Object.freeze({
  activeServiceId: "gmail",
  notificationsEnabled: true,
  memorySaverEnabled: true,
  memorySaverTimeoutMinutes: DEFAULT_MEMORY_SAVER_TIMEOUT_MINUTES,
  sidebarCollapsed: false,
  windowMode: "full",
  dockCorner: "bottom-left",
  dockHeight: 420,
  dockExpanded: true,
  bubbleSize: Object.freeze({ width: 980, height: 820 }),
  closeToTray: false,
  launchAtLogin: false,
  startMinimized: false,
  askWhereToSaveDownloads: false
});

const resolveActiveServiceId = (requestedId, services) => {
  const requested = services.find((service) => service.id === requestedId);
  if (requested?.isEnabled) return requested.id;
  return services.find((service) => service.isEnabled)?.id ?? null;
};

export const normalizeUi = (rawUi, services) => {
  const ui = isPlainObject(rawUi) ? rawUi : {};
  return {
    activeServiceId: resolveActiveServiceId(ui.activeServiceId ?? defaultUi.activeServiceId, services),
    notificationsEnabled: booleanOr(ui.notificationsEnabled, defaultUi.notificationsEnabled),
    memorySaverEnabled: booleanOr(ui.memorySaverEnabled, defaultUi.memorySaverEnabled),
    memorySaverTimeoutMinutes: normalizeMemorySaverTimeout(ui.memorySaverTimeoutMinutes),
    sidebarCollapsed: booleanOr(ui.sidebarCollapsed, defaultUi.sidebarCollapsed),
    windowMode: WINDOW_MODES.includes(ui.windowMode) ? ui.windowMode : defaultUi.windowMode,
    dockCorner: normalizeDockCorner(ui.dockCorner),
    dockHeight: clampDockHeight(ui.dockHeight ?? defaultUi.dockHeight),
    dockExpanded: booleanOr(ui.dockExpanded, defaultUi.dockExpanded),
    bubbleSize: normalizePreferredBubbleSize(ui.bubbleSize),
    closeToTray: booleanOr(ui.closeToTray, defaultUi.closeToTray),
    launchAtLogin: booleanOr(ui.launchAtLogin, defaultUi.launchAtLogin),
    startMinimized: booleanOr(ui.startMinimized, defaultUi.startMinimized),
    askWhereToSaveDownloads: booleanOr(ui.askWhereToSaveDownloads, defaultUi.askWhereToSaveDownloads)
  };
};

export const uiEquals = (left, right) => sameValue(left, right);

const appSettingBooleans = ["closeToTray", "launchAtLogin", "startMinimized", "askWhereToSaveDownloads"];

/** Whitelist for `ui:set-settings`; invalid or unknown keys are dropped. */
export const sanitizeAppSettings = (partial) => {
  const source = isPlainObject(partial) ? partial : {};
  const settings = {};
  if (rendererLimits.memorySaverTimeoutOptions.includes(source.memorySaverTimeoutMinutes)) {
    settings.memorySaverTimeoutMinutes = source.memorySaverTimeoutMinutes;
  }
  for (const key of appSettingBooleans) {
    if (typeof source[key] === "boolean") settings[key] = source[key];
  }
  return settings;
};

export const PERMISSION_DECISIONS = Object.freeze(["allow", "block"]);
const maxOriginsPerService = 100;
const permissionNamePattern = /^[a-z][a-z0-9-]{0,39}$/;

export const normalizePermissionOrigin = (origin) => {
  if (typeof origin !== "string" || origin.length > 300 || !isHttpUrl(origin)) return null;
  try {
    const parsed = new URL(origin).origin;
    return parsed === origin ? parsed : null;
  } catch {
    return null;
  }
};

export const isValidPermissionName = (permission) =>
  typeof permission === "string" && permissionNamePattern.test(permission);

/** `{ [serviceId]: { [origin]: { [permission]: "allow" | "block" } } }` */
export const normalizePermissionDecisions = (raw) => {
  const result = {};
  if (!isPlainObject(raw)) return result;
  for (const [serviceId, origins] of Object.entries(raw)) {
    if (!serviceId || serviceId.length > 200 || !isPlainObject(origins)) continue;
    const byOrigin = {};
    for (const [origin, decisions] of Object.entries(origins).slice(0, maxOriginsPerService)) {
      if (!normalizePermissionOrigin(origin) || !isPlainObject(decisions)) continue;
      const valid = Object.fromEntries(
        Object.entries(decisions).filter(
          ([permission, decision]) => isValidPermissionName(permission) && PERMISSION_DECISIONS.includes(decision)
        )
      );
      if (Object.keys(valid).length) byOrigin[origin] = valid;
    }
    if (Object.keys(byOrigin).length) result[serviceId] = byOrigin;
  }
  return result;
};

/** Returns a structural problem that makes the file unusable, or null. */
export const validateConfigShape = (data) => {
  if (!isPlainObject(data)) return "Config root must be an object.";
  if ("services" in data && !Array.isArray(data.services)) return "Config `services` must be an array.";
  if ("ui" in data && !isPlainObject(data.ui)) return "Config `ui` must be an object.";
  if ("notificationHistory" in data && !Array.isArray(data.notificationHistory)) {
    return "Config `notificationHistory` must be an array.";
  }
  if ("permissionDecisions" in data && !isPlainObject(data.permissionDecisions)) {
    return "Config `permissionDecisions` must be an object.";
  }
  return null;
};

// In v1, "Desktop alerts" off only hid Comms Hub's extra copy; the page's own toast still
// showed. v2 shows only Comms Hub's toast, so an app that captured page notifications keeps
// its toasts by turning desktopEnabled back on. Apps with capture off too stay as they were.
const migrateV1NotificationSettings = (service) =>
  service.notificationSettings.desktopEnabled === false &&
  service.notificationSettings.captureWebNotifications !== false
    ? { ...service, notificationSettings: { ...service.notificationSettings, desktopEnabled: true } }
    : service;

/**
 * Builds the canonical in-memory config from whatever is on disk. `changed` is true when the
 * stored file should be rewritten once: older versions froze built-in fields into it and
 * persisted notification history (D6, D15).
 */
export const migrateConfig = (raw) => {
  const source = isPlainObject(raw) ? raw : {};
  const storedVersion = Number.isInteger(source.configVersion) ? source.configVersion : 1;
  const storedServices = normalizeServiceList(Array.isArray(source.services) ? source.services : []);
  const services = storedVersion < 2 ? storedServices.map(migrateV1NotificationSettings) : storedServices;
  const config = {
    configVersion: Math.max(storedVersion, CONFIG_VERSION),
    services,
    ui: normalizeUi(source.ui, services),
    permissionDecisions: normalizePermissionDecisions(source.permissionDecisions),
    // Main-window placement (D18). Main-process only: not part of the renderer snapshot.
    mainWindowState: normalizeWindowState(source.mainWindowState)
  };
  const changed =
    storedVersion < CONFIG_VERSION ||
    "notificationHistory" in source ||
    (isPlainObject(source.ui) && "notificationLastSeenByService" in source.ui);
  return { config, changed };
};

export const toPersistedConfig = (config) => ({
  configVersion: config.configVersion,
  services: config.services.map(toPersistedService),
  ui: config.ui,
  permissionDecisions: config.permissionDecisions,
  ...(config.mainWindowState ? { mainWindowState: config.mainWindowState } : {})
});

/** The immutable snapshot returned by getAppState() and broadcast to app-shell windows. */
export const buildAppState = (config, capabilities = getDockModeCapabilities(process.platform)) =>
  deepFreeze({
    services: config.services,
    ui: config.ui,
    capabilities,
    iconLibrary,
    limits: rendererLimits
  });
