import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import Store from "electron-store";
import { v4 as uuidv4 } from "uuid";

const svgToDataUrl = (svg) =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

const modernChromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

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

export const builtInServices = [
  {
    id: "gmail",
    name: "Gmail",
    url: "https://mail.google.com/mail/u/0/#inbox",
    iconSource: builtinIcons.gmail,
    iconKey: "gmail",
    isBuiltIn: true,
    isEnabled: true,
    sessionPartition: "persist:service-gmail",
    supportsBadgeDetection: true,
    notificationSettings: {
      desktopEnabled: true,
      badgeEnabled: true,
      captureWebNotifications: true
    }
  },
  {
    id: "discord",
    name: "Discord",
    url: "https://discord.com/app",
    iconSource: builtinIcons.discord,
    iconKey: "discord",
    isBuiltIn: true,
    isEnabled: true,
    sessionPartition: "persist:service-discord",
    supportsBadgeDetection: true,
    notificationSettings: {
      desktopEnabled: true,
      badgeEnabled: true,
      captureWebNotifications: true
    }
  },
  {
    id: "messenger",
    name: "Messenger",
    url: "https://www.facebook.com/messages/",
    iconSource: builtinIcons.messenger,
    iconKey: "messenger",
    isBuiltIn: true,
    isEnabled: true,
    sessionPartition: "persist:service-messenger",
    supportsBadgeDetection: true,
    notificationSettings: {
      desktopEnabled: true,
      badgeEnabled: true,
      captureWebNotifications: true
    }
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://app.slack.com/client",
    iconSource: builtinIcons.slack,
    iconKey: "slack",
    isBuiltIn: true,
    isEnabled: true,
    sessionPartition: "persist:service-slack",
    supportsBadgeDetection: true,
    notificationSettings: {
      desktopEnabled: true,
      badgeEnabled: true,
      captureWebNotifications: true
    }
  },
  {
    id: "teams",
    name: "Teams",
    url: "https://teams.microsoft.com/v2/",
    iconSource: builtinIcons.teams,
    iconKey: "teams",
    isBuiltIn: true,
    isEnabled: true,
    sessionPartition: "persist:service-teams",
    supportsBadgeDetection: true,
    userAgent: modernChromeUserAgent,
    notificationSettings: {
      desktopEnabled: true,
      badgeEnabled: true,
      captureWebNotifications: true
    }
  }
];

export const iconLibrary = [
  { key: "gmail", label: "Gmail", iconSource: builtinIcons.gmail },
  { key: "discord", label: "Discord", iconSource: builtinIcons.discord },
  { key: "messenger", label: "Messenger", iconSource: builtinIcons.messenger },
  { key: "slack", label: "Slack", iconSource: builtinIcons.slack },
  { key: "teams", label: "Teams", iconSource: builtinIcons.teams },
  { key: "globe", label: "Generic Web App", iconSource: builtinIcons.globe }
];

const migrateBuiltInOverrides = (service, builtin) => {
  if (!builtin) {
    return service;
  }

  if (
    service.id === "messenger" &&
    (service.url === "https://www.messenger.com/" ||
      service.url === "https://messenger.com/")
  ) {
    return {
      ...service,
      url: builtin.url
    };
  }

  return service;
};

const schema = {
  services: {
    type: "array",
    default: builtInServices
  },
  ui: {
    type: "object",
    default: {
      activeServiceId: "gmail",
      notificationsEnabled: true,
      memorySaverEnabled: true,
      sidebarCollapsed: false,
      notificationLastSeenByService: {}
    }
  },
  notificationHistory: {
    type: "array",
    default: []
  }
};

const store = new Store({
  name: "comms-app-config",
  schema
});

const ensureIconsDir = () => {
  const iconsDir = path.join(app.getPath("userData"), "icons");
  fs.mkdirSync(iconsDir, { recursive: true });
  return iconsDir;
};

const mergeBuiltIns = (storedServices) => {
  const byId = new Map(storedServices.map((service) => [service.id, service]));

  return [
    ...storedServices.map((service) => {
      const builtin = builtInServices.find((item) => item.id === service.id);
      const merged = builtin
        ? {
            ...builtin,
            ...service
          }
        : service;

      return migrateBuiltInOverrides(merged, builtin);
    }),
    ...builtInServices
      .filter((builtin) => !byId.has(builtin.id))
      .map((builtin) => ({
        ...builtin
      }))
  ];
};

const normalizeNotificationSettings = (settings = {}) => ({
  desktopEnabled: settings.desktopEnabled ?? true,
  badgeEnabled: settings.badgeEnabled ?? true,
  captureWebNotifications: settings.captureWebNotifications ?? true
});

const normalizeService = (service, existing) => ({
  id: service.id,
  name: service.name?.trim() || "Untitled App",
  url: service.url?.trim() || "https://example.com",
  iconSource: service.iconSource || builtinIcons.globe,
  iconKey: service.iconKey ?? "globe",
  isBuiltIn: existing?.isBuiltIn ?? service.isBuiltIn ?? false,
  isEnabled: service.isEnabled ?? existing?.isEnabled ?? true,
  sessionPartition: existing?.sessionPartition ?? service.sessionPartition ?? `persist:service-${service.id}`,
  supportsBadgeDetection: service.supportsBadgeDetection ?? existing?.supportsBadgeDetection ?? true,
  userAgent: service.userAgent ?? existing?.userAgent ?? null,
  notificationSettings: normalizeNotificationSettings(
    service.notificationSettings ?? existing?.notificationSettings
  )
});

export const getAppState = () => {
  const storedServices = store.get("services", builtInServices);
  const services = mergeBuiltIns(storedServices).map((service) => normalizeService(service, service));
  const rawUi = store.get("ui");
  const notificationHistory = store.get("notificationHistory", []);
  const ui = {
    activeServiceId: rawUi.activeServiceId ?? services[0]?.id ?? null,
    notificationsEnabled: rawUi.notificationsEnabled ?? true,
    memorySaverEnabled: rawUi.memorySaverEnabled ?? true,
    sidebarCollapsed: rawUi.sidebarCollapsed ?? false,
    notificationLastSeenByService: rawUi.notificationLastSeenByService ?? {}
  };

  return {
    services,
    ui,
    iconLibrary,
    notificationHistory
  };
};

export const saveAppState = ({ services, ui }) => {
  store.set("services", mergeBuiltIns(services).map((service) => normalizeService(service, service)));
  store.set("ui", ui);
};

export const upsertService = (partialService) => {
  const state = getAppState();
  const existing = state.services.find((service) => service.id === partialService.id);
  const id = partialService.id ?? uuidv4();
  const nextService = normalizeService({ ...partialService, id }, existing);

  const services = existing
    ? state.services.map((service) => (service.id === id ? { ...service, ...nextService } : service))
    : [...state.services, nextService];

  const shouldSwitchToNewApp = !existing;
  const activeServiceId =
    !nextService.isEnabled && state.ui.activeServiceId === id
      ? services.find((service) => service.id !== id && service.isEnabled)?.id ?? null
      : shouldSwitchToNewApp
        ? id
        : state.ui.activeServiceId;

  saveAppState({
    services,
    ui: {
      ...state.ui,
      activeServiceId
    }
  });
  return getAppState();
};

export const removeService = (serviceId) => {
  const state = getAppState();
  const target = state.services.find((service) => service.id === serviceId);
  if (!target || target.isBuiltIn) {
    return state;
  }

  const services = state.services.filter((service) => service.id !== serviceId);
  const nextActiveId =
    state.ui.activeServiceId === serviceId
      ? services.find((service) => service.isEnabled)?.id ?? null
      : state.ui.activeServiceId;

  saveAppState({
    services,
    ui: { ...state.ui, activeServiceId: nextActiveId }
  });
  return getAppState();
};

export const reorderServices = (serviceIds) => {
  const state = getAppState();
  const existingMap = new Map(state.services.map((service) => [service.id, service]));
  const ordered = serviceIds.map((id) => existingMap.get(id)).filter(Boolean);
  const remaining = state.services.filter((service) => !serviceIds.includes(service.id));

  saveAppState({ services: [...ordered, ...remaining], ui: state.ui });
  return getAppState();
};

export const setUiState = (uiUpdates) => {
  const state = getAppState();
  const nextLastSeen = uiUpdates.notificationLastSeenByService
    ? {
        ...state.ui.notificationLastSeenByService,
        ...uiUpdates.notificationLastSeenByService
      }
    : state.ui.notificationLastSeenByService;

  saveAppState({
    services: state.services,
    ui: {
      ...state.ui,
      ...uiUpdates,
      notificationLastSeenByService: nextLastSeen
    }
  });

  return getAppState();
};

export const markServiceNotificationsSeen = (serviceId) => {
  if (!serviceId) {
    return getAppState();
  }

  return setUiState({
    notificationLastSeenByService: {
      [serviceId]: new Date().toISOString()
    }
  });
};

export const appendNotificationHistory = (entry) => {
  const state = getAppState();
  const nextHistory = [entry, ...state.notificationHistory].slice(0, 80);
  store.set("notificationHistory", nextHistory);
  return getAppState();
};

export const clearNotificationHistory = () => {
  store.set("notificationHistory", []);
  return getAppState();
};

export const copyIconToUserData = (sourcePath) => {
  const iconsDir = ensureIconsDir();
  const extension = path.extname(sourcePath) || ".png";
  const filename = `${uuidv4()}${extension}`;
  const destinationPath = path.join(iconsDir, filename);
  fs.copyFileSync(sourcePath, destinationPath);
  return `file://${destinationPath.replace(/\\/g, "/")}`;
};
