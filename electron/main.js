// Must stay the first import: it fixes the profile and claims the single-instance lock.
import { hasInstanceLock, isDev } from "./bootstrap.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  WebContentsView,
  webContents
} from "electron";
import {
  clearPermissionDecisions,
  copyIconToUserData,
  flushPendingWrites,
  getAppState,
  getConfigLoadIssue,
  getIconsDirectory,
  getMainWindowState,
  getPermissionDecision,
  hasPermissionDecisions,
  iconLibrary,
  removeService,
  reorderServices,
  setAppSettings,
  setMainWindowState,
  setPermissionDecision,
  setUiState,
  upsertService
} from "./configStore.js";
import { siteAliasesFor } from "./appStateModel.js";
import { createServiceManager, clampServiceZoom } from "./serviceManager.js";
import {
  BUBBLE_DEFAULT_SIZE,
  DOCK_WINDOW_SIZE,
  WINDOW_SIDE_INSET,
  WINDOW_VERTICAL_INSET,
  getBubbleBoundsForWorkArea,
  getBubbleConstraints,
  getDockBoundsForWorkArea,
  getDockModeCapabilities,
  normalizePreferredBubbleSize,
  restoreWindowBounds
} from "./windowGeometry.js";
import {
  applyBoundsIfChanged,
  configureUtilityWindowOnce,
  createCoalescedAsyncRunner,
  planDockVisibility,
  setUtilityWindowVisibility
} from "./dockController.js";
import { MAIN_WINDOW_MIN_SIZE, clampDockHeight, isHttpUrl, normalizeDockCorner } from "./limits.js";
import { createNotificationHistory } from "./notificationHistory.js";
import { writeStartupDiagnostic } from "./diagnostics.js";
import { countUnread, loginItemSettingsFor, shouldStartHidden } from "./appLifecycle.js";
import { getAppIcon, getTrayIcon } from "./appIcon.js";
import { createTrayController } from "./trayController.js";
import { createExternalOpener, createRateLimiter } from "./linkPolicy.js";
import {
  createShellDocumentMatcher,
  isGitHubReleaseUrl,
  isServiceOwnedUrl,
  normalizeServiceUrl,
  originOf
} from "./urlPolicy.js";
import {
  PERMISSION_KEYS,
  createPermissionPrompter,
  decidePermissionCheck,
  decidePermissionRequest,
  permissionPromptAnswer,
  permissionPromptOptions,
  requestingOriginOf
} from "./permissionPolicy.js";
import { DENY_SCREEN_SHARE, SCREEN_SHARE_THUMBNAIL_SIZE, createScreenShareBroker } from "./screenShare.js";
import { ICON_UPLOAD_EXTENSIONS, sanitizeServiceInput } from "./serviceInput.js";
import { createShellIpc } from "./shellIpc.js";
import { badgeCountsFor, overlayDescription, parseBadgeCount, parseOverlayBadge } from "./badges.js";
import {
  NOTIFICATION_INTAKE_LIMIT,
  createDesktopNotifier,
  sanitizeGuestNotification,
  shouldShowDesktopToast
} from "./desktopNotifications.js";
import { createFrameStateQuery, frameKeyOf, frameTargetsFor } from "./guestFrames.js";
import { summarizeServiceMetrics } from "./serviceMetrics.js";
import { compareVersions, getPlatformAsset, normalizeVersion } from "./updates.js";
import {
  applicationMenuTemplate,
  cycleServiceId,
  resolveAppCommand,
  resolveShortcut,
  serviceIdAtIndex,
  stepZoomFactor
} from "./shortcuts.js";
import { buildGuestContextMenu, buildServiceRailMenu, buildShellContextMenu } from "./contextMenu.js";
import {
  blankPopupLeavesApp,
  clampPopupBounds,
  createPopupGate,
  decideWindowOpen,
  isBlankPopupUrl,
  isIdentityProviderUrl,
  popupNavigationLeavesApp,
  popupWindowOptions
} from "./popupPolicy.js";
import { createDownloadManager } from "./downloads.js";
import { cleanUserAgent } from "./userAgent.js";
import { createFindTracker, normalizeStopFindAction } from "./findInPage.js";
import { removalPlan, removeConfirmOptions, unusedIconFile } from "./serviceRemoval.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);

let mainWindow = null;
let dockWindow = null;
let bubbleWindow = null;
let dockTriggerWindow = null;
let serviceManager = null;
const serviceViewports = new Map();
// serviceId -> { count, webContentsId } from page titles; shown only while that page is loaded.
const titleBadgeCounts = new Map();
const notificationHistory = createNotificationHistory();
// The last taskbar overlay the renderer asked for: { image, description } or null.
let overlayBadge = null;
// Polls connectivity while a service waits to retry a failed load.
let onlineWatchTimer = null;
let lastKnownOnline = true;
const onlineWatchIntervalMs = 10000;
// webContents id -> session of each live guest page; only these are flushed periodically.
const liveGuestSessions = new Map();
let quitRequested = false;
let shutdownInProgress = false;
let dockHideTimeout = null;
let dockTeardownTimer = null;
let mainTeardownTimer = null;
let bubbleResizeTimeout = null;
let dockWindowCreation = null;
let bubbleWindowCreation = null;
let dockTriggerWindowCreation = null;
let dockTriggerCorner = null;
// True from a hidden start (login item or "start minimized") until the first window pass is done.
let startHidden = false;
// maximize() also shows a window, so a saved maximized state is applied when it is first shown.
let maximizeMainOnShow = false;
let mainWindowStateTimer = null;
const mainWindowStateSaveDelayMs = 500;
const isLinux = process.platform === "linux";
const guestPreloadPath = path.join(__dirname, "guestPreload.js");
const updatesRepository =
  packageJson.repository?.url?.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/)?.[1] ?? null;
const configuredSessions = new WeakSet();
// Child windows a service opened (D13): popup webContents id -> the opening guest's webContents id.
const popupOwners = new Map();
const popupShowFallbackMs = 1500;
// Caps how many popups each service has open at once and opens per 30 s (POP-3).
const popupGate = createPopupGate();
const dockWindowSize = {
  dock: DOCK_WINDOW_SIZE,
  bubble: BUBBLE_DEFAULT_SIZE,
  crossMargin: WINDOW_VERTICAL_INSET
};
const dockTriggerSize = {
  width: 18,
  height: 112
};
const dockHideDelayMs = 150;
// Dock-mode windows are destroyed this long after leaving dock mode, so quick toggles stay instant.
const dockTeardownDelayMs = 45000;
// The hidden main window is destroyed this long after entering dock mode from full mode. Keep it
// different from dockTeardownDelayMs: the app-shell fixture shortens every 45 s timer.
const mainTeardownDelayMs = 60000;
const sessionFlushIntervalMs = 5 * 60 * 1000;
const triggerPagePath = path.join(__dirname, "trigger.html");
const distEntryPath = path.join(__dirname, "..", "dist", "index.html");
const devServerOrigin = "http://localhost:5173";
// File paths follow the real OS (tests may spoof process.platform after node:path was loaded).
const pathPlatform = path.sep === "\\" ? "win32" : "posix";
// The only documents app-shell windows may show: the built renderer, the trigger page and, in
// dev runs, the Vite server. Used for the navigation lock and IPC sender checks.
const isShellDocumentUrl = createShellDocumentMatcher({
  files: [distEntryPath, triggerPagePath],
  devOrigin: isDev ? devServerOrigin : null,
  platform: pathPlatform
});
const updateCheckCacheMs = 10 * 60 * 1000;
let lastUpdateCheck = null;
// webContents id -> number of in-app screen-share pickers its renderer has subscribed.
const screenSharePickers = new Map();

// A platform constant; the app-shell fixture sets process.platform before importing this module.
const dockModeSupported =
  process.platform !== "linux" && getDockModeCapabilities(process.platform).dockModeSupported !== false;
const supportsDockMode = () => dockModeSupported;

const isSafeHttpUrl = isHttpUrl;

const checkForUpdates = async () => {
  const currentVersion = app.getVersion();

  if (!updatesRepository) {
    return {
      status: "unconfigured",
      currentVersion,
      platform: process.platform
    };
  }

  const response = await fetch(`https://api.github.com/repos/${updatesRepository}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Comms-Hub-Updater"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed with status ${response.status}`);
  }

  const release = await response.json();
  const latestVersion = normalizeVersion(release.tag_name || release.name || currentVersion);
  const asset = getPlatformAsset(release.assets);

  return {
    status: compareVersions(latestVersion, currentVersion) > 0 ? "update-available" : "up-to-date",
    currentVersion,
    latestVersion,
    platform: process.platform,
    releaseName: release.name || release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    assetName: asset?.name ?? null,
    assetUrl: asset?.browser_download_url ?? null
  };
};

// The last successful check is reused by "open download" for a while (GitHub allows 60 calls/hour).
const runUpdateCheck = async () => {
  const info = await checkForUpdates();
  lastUpdateCheck = { at: Date.now(), info };
  return info;
};

// A popup acts for the service that opened it (permissions, link prompts, downloads).
const serviceForContents = (contents) => {
  if (!contents || contents.isDestroyed()) return null;
  const serviceId =
    serviceManager?.getServiceIdForContents(contents.id) ??
    serviceManager?.getServiceIdForContents(popupOwners.get(contents.id));
  return serviceId ? getAppState().services.find((service) => service.id === serviceId) ?? null : null;
};

// Electron's user agent without the Electron and app tokens (D15); a service's own userAgent wins.
let guestUserAgent = null;
const getGuestUserAgent = () => {
  guestUserAgent ??= cleanUserAgent(app.userAgentFallback, {
    chromeVersion: process.versions.chrome,
    appNames: [app.getName(), packageJson.name, packageJson.productName]
  });
  return guestUserAgent;
};

const topLevelUrlOf = (contents) => {
  try {
    return contents && !contents.isDestroyed() ? contents.getURL() : null;
  } catch {
    return null;
  }
};

/** The service page a popup belongs to (the contents itself when it is not a popup). */
const ownerContentsOf = (contents) => {
  if (!contents || contents.isDestroyed()) return null;
  const ownerId = popupOwners.get(contents.id);
  if (ownerId === undefined) return contents;
  const owner = webContents.fromId(ownerId);
  return owner && !owner.isDestroyed() ? owner : null;
};
const ownerIdOf = (contentsId) => popupOwners.get(contentsId) ?? contentsId;
/** The service page's top-level URL, also for its popups (never the popup's own URL). */
const guestTopLevelUrlOf = (contents) => topLevelUrlOf(ownerContentsOf(contents));

/**
 * D10: other URLs whose sites are the service's own besides its address: a built-in's fixed
 * aliases and where its home address landed. Tied to the service, so whatever page the view or
 * a popup shows now never makes that page's site "owned".
 */
const ownedAliasesFor = (contents, service) => {
  if (!service) return [];
  const owner = ownerContentsOf(contents);
  const landing = owner ? serviceManager?.getLandingUrl(owner.id) : null;
  return landing ? [...siteAliasesFor(service), landing] : siteAliasesFor(service);
};

/** The window showing services right now, if the user can see it (dialog parent). */
const visibleServiceHost = () => {
  const host = currentServiceHost();
  return isLiveWindow(host) && host.isVisible() ? host : null;
};

const showMessageBox = (options, parent = visibleServiceHost()) =>
  parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);

/** A native toast for an error nobody would see in a window (respects the global alerts switch). */
const showStatusToast = (text) => {
  try {
    if (!Notification.isSupported() || getAppState().ui.notificationsEnabled === false) return;
    new Notification({ title: "Comms Hub", body: String(text) }).show();
  } catch (error) {
    writeStartupDiagnostic("Failed to show a status notification.", error);
  }
};

/**
 * `ui:status` to a window the user can see (downloads, blocked links, ...): the visible service
 * host, else a visible main window. With none (collapsed dock, app in the tray) an error becomes
 * a native toast unless `toastFallback` is false; info messages are dropped.
 */
const sendStatusMessage = (text, tone = "info", { toastFallback = true } = {}) => {
  const message = { text: String(text), tone: tone === "error" ? "error" : "info" };
  const target = [visibleServiceHost(), isLiveWindow(mainWindow) && mainWindow.isVisible() ? mainWindow : null].find(isLiveWindow);
  if (target) target.webContents.send("ui:status", message);
  else if (message.tone === "error" && toastFallback) showStatusToast(message.text);
};

// Downloads (D8). Progress shows on the taskbar buttons of the main window and the service host.
const downloadProgressWindows = new Set();
const setDownloadProgress = (progress) => {
  const targets = progress === null ? [...downloadProgressWindows] : [mainWindow, currentServiceHost()].filter(isLiveWindow);
  for (const target of targets) {
    try {
      if (!isLiveWindow(target)) continue;
      if (progress === null) target.setProgressBar(-1);
      else if (progress === "indeterminate") target.setProgressBar(2, { mode: "indeterminate" });
      else target.setProgressBar(progress, { mode: "normal" });
      if (progress !== null) downloadProgressWindows.add(target);
    } catch (error) {
      writeStartupDiagnostic("Failed to show download progress.", error);
    }
  }
  if (progress === null) downloadProgressWindows.clear();
};
// Recent download toasts stay referenced so a click from the Action Center still works.
const downloadToasts = new Set();
const showDownloadToast = ({ fileName, savePath }) => {
  sendStatusMessage(`Downloaded ${fileName}.`);
  try {
    if (!Notification.isSupported()) return;
    const toast = new Notification({ title: "Download complete", body: `${fileName}
Click to show it in its folder.` });
    toast.on("click", () => {
      downloadToasts.delete(toast);
      if (savePath) shell.showItemInFolder(savePath);
    });
    toast.on("failed", () => downloadToasts.delete(toast));
    downloadToasts.add(toast);
    if (downloadToasts.size > 10) downloadToasts.delete(downloadToasts.values().next().value);
    toast.show();
  } catch (error) {
    writeStartupDiagnostic("Failed to show the download notification.", error);
  }
};
// A failure gets a toast like a completion, so it is not missed while no window is visible.
const showDownloadFailedToast = ({ fileName }) => {
  sendStatusMessage(`The download of ${fileName} failed.`, "error", { toastFallback: false });
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title: "Download failed", body: String(fileName) }).show();
  } catch (error) {
    writeStartupDiagnostic("Failed to show the download notification.", error);
  }
};
const downloads = createDownloadManager({
  getDirectory: () => app.getPath("downloads"),
  askWhereToSave: () => getAppState().ui.askWhereToSaveDownloads === true,
  isTaken: (candidate) => fs.existsSync(candidate),
  prepareDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  setProgress: setDownloadProgress,
  onCompleted: showDownloadToast,
  onFailed: showDownloadFailedToast,
  log: writeStartupDiagnostic
});

const takeLinkNotice = createRateLimiter({ count: 1, windowMs: 4000 });
const externalLinks = createExternalOpener({
  openExternal: (url) => shell.openExternal(url),
  confirm: async (verdict, { serviceName }) => {
    const { response } = await showMessageBox({
      type: verdict.appName ? "question" : "warning",
      title: "Open link",
      message: verdict.appName ? `Open ${verdict.appName}?` : "Open this link in another app?",
      detail: `${serviceName ?? "Comms Hub"} wants to open:\n${verdict.url.slice(0, 300)}`,
      buttons: ["Open", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    return response === 0;
  },
  onBlocked: (verdict, { serviceName }) => {
    // window.open("") asks for about:blank; that is not worth a notice.
    if (verdict.scheme === "about:" || !takeLinkNotice("blocked")) return;
    const target = verdict.scheme ? `"${verdict.scheme}"` : "an invalid address";
    writeStartupDiagnostic(`Blocked a link to ${target}${serviceName ? ` from ${serviceName}` : ""}.`);
    sendStatusMessage(`Blocked a link that tried to open ${target} outside Comms Hub.`, "error");
  },
  onDropped: (verdict, { serviceName }) => {
    if (takeLinkNotice("dropped")) {
      writeStartupDiagnostic(`Ignored repeated ${verdict.scheme} links${serviceName ? ` from ${serviceName}` : ""}.`);
    }
  },
  log: writeStartupDiagnostic
});

/** Every external open goes through the link policy (D14). Resolves to the opener's outcome. */
const openExternalLink = (url, context = {}) => externalLinks.open(url, context).catch(() => "failed");

const linkContextFor = (contents) => ({
  source: contents?.id ?? "unknown",
  serviceName: serviceForContents(contents)?.name ?? null
});

const permissionPrompter = createPermissionPrompter({
  showPrompt: async ({ serviceName, origin, keys }) => {
    return permissionPromptAnswer(await showMessageBox(permissionPromptOptions({ serviceName, origin, keys })));
  },
  remember: (serviceId, origin, key, decision) => setPermissionDecision(serviceId, origin, key, decision),
  log: writeStartupDiagnostic
});

const screenShareBroker = createScreenShareBroker({
  describeGuest: (guestId) => {
    const service = serviceForContents(webContents.fromId(guestId));
    return service ? { serviceId: service.id, serviceName: service.name } : null;
  },
  getSources: async () => {
    // The dock rail and trigger are app chrome, not something to share.
    const chrome = new Set([dockWindow, dockTriggerWindow].filter(isLiveWindow).map((window) => window.getMediaSourceId()));
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: SCREEN_SHARE_THUMBNAIL_SIZE,
      fetchWindowIcons: true
    });
    return sources.filter((source) => !chrome.has(source.id));
  },
  prepareHost: async () => {
    await revealApp();
    const host = currentServiceHost();
    if (!isLiveWindow(host)) return null;
    // The page that asked had the keyboard; the picker (shell DOM) needs it.
    host.webContents.focus();
    const id = host.webContents.id;
    return {
      id,
      window: host,
      hasPicker: (screenSharePickers.get(id) ?? 0) > 0,
      send: (channel, payload) => {
        if (!host.isDestroyed()) host.webContents.send(channel, payload);
      }
    };
  },
  showNativePicker: ({ host, options, signal }) =>
    showMessageBox({ ...options, signal }, isLiveWindow(host.window) ? host.window : null),
  watchGuest: (guestId, onGone) => {
    const contents = webContents.fromId(guestId);
    if (!contents || contents.isDestroyed()) {
      onGone();
      return () => {};
    }
    const onNavigation = (details) => {
      if (details?.isMainFrame && !details.isSameDocument) onGone();
    };
    contents.on("did-start-navigation", onNavigation);
    contents.on("render-process-gone", onGone);
    contents.once("destroyed", onGone);
    return () => {
      contents.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("render-process-gone", onGone);
      contents.removeListener("destroyed", onGone);
    };
  },
  // Only a chosen source protects the service from the memory saver.
  onPicked: (guestId) => serviceManager?.protectMedia(ownerIdOf(guestId)),
  onChange: () => presentManagedService(),
  log: writeStartupDiagnostic
});

const setScreenSharePicker = (contentsId, active) => {
  const count = Math.max(0, (screenSharePickers.get(contentsId) ?? 0) + (active ? 1 : -1));
  if (count) screenSharePickers.set(contentsId, count);
  else screenSharePickers.delete(contentsId);
  if (active) flushOverlayRequests(contentsId);
};

// Requests for a window's find bar and edit dialog (`ui:find-requested`, `ui:edit-service`).
// A window that was just created (e.g. a bubble opened by the request) may not listen yet. Its
// in-app picker subscription comes from the same renderer hook, so requests are held until main
// hears of it. webContents id -> Map(channel -> payload).
const pendingOverlayRequests = new Map();
const sendOverlayRequest = (target, channel, payload) => {
  if (!isLiveWindow(target)) return false;
  if (!target.isFocused()) target.focus();
  // Chromium focus too: without it the keyboard stays in the service page (typing would go to
  // the chat instead of the find bar or dialog).
  target.webContents.focus();
  const contentsId = target.webContents.id;
  if ((screenSharePickers.get(contentsId) ?? 0) > 0) {
    target.webContents.send(channel, payload);
  } else {
    const pending = pendingOverlayRequests.get(contentsId) ?? new Map();
    pending.set(channel, payload);
    pendingOverlayRequests.set(contentsId, pending);
  }
  return true;
};
const flushOverlayRequests = (contentsId) => {
  const pending = pendingOverlayRequests.get(contentsId);
  if (!pending) return;
  pendingOverlayRequests.delete(contentsId);
  const contents = webContents.fromId(contentsId);
  if (!contents || contents.isDestroyed()) return;
  for (const [channel, payload] of pending) contents.send(channel, payload);
};

// Closing the find bar removes the focused element, so the shell document is left focused on
// nothing: the keyboard goes back to the service page. Clearing the text also ends the search,
// but focus is still in the bar then, so it stays there.
const returnFocusAfterFind = (sender) => {
  if (!sender || sender.isDestroyed()) return;
  sender
    .executeJavaScript("document.hasFocus() && (!document.activeElement || document.activeElement === document.body)")
    .then((closed) => {
      const host = currentServiceHost();
      const guest = serviceManager?.getContents();
      if (closed !== true || !guest || !isLiveWindow(host) || host.webContents !== sender) return;
      if (host.contentView.children.some((child) => child.webContents === guest)) guest.focus();
    })
    .catch(() => {});
};

// D10: camera/mic for the service's own site, a remembered decision or a prompt; screen capture
// only for a source just picked in the picker (D9); notifications, fullscreen and clipboard writes
// for web pages; nothing else.
const configureSessionPermissions = (targetSession) => {
  if (!targetSession || configuredSessions.has(targetSession)) {
    return;
  }

  targetSession.on("will-download", (_event, item) => {
    try {
      downloads.handle(item);
    } catch (error) {
      writeStartupDiagnostic("Failed to start a download.", error);
    }
  });

  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    try {
      const service = serviceForContents(contents);
      const origin = requestingOriginOf(details, requestingOrigin);
      return decidePermissionCheck({
        permission,
        mediaType: details?.mediaType,
        origin,
        service,
        ownedAliases: ownedAliasesFor(contents, service),
        decisionFor: (key) => (service ? getPermissionDecision(service.id, origin, key) : null)
      });
    } catch {
      return false;
    }
  });

  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    try {
      const service = serviceForContents(contents);
      const origin = requestingOriginOf(details);
      const decision = decidePermissionRequest({
        permission,
        mediaTypes: details?.mediaTypes,
        origin,
        service,
        ownedAliases: ownedAliasesFor(contents, service),
        decisionFor: (key) => (service ? getPermissionDecision(service.id, origin, key) : null)
      });
      if (decision.action === "open-external") {
        // Unintercepted external links (e.g. a mailto: link in a subframe) use the link policy too.
        callback(false);
        openExternalLink(details?.externalURL, linkContextFor(contents));
        return;
      }
      const answer = (allowed) => {
        if (allowed && decision.keys.some((key) => key !== PERMISSION_KEYS.screen)) {
          try {
            // A popup's call keeps the service that opened it awake.
            serviceManager?.protectMedia(ownerIdOf(contents.id));
          } catch (error) {
            writeStartupDiagnostic("Failed to protect a service using the camera or microphone.", error);
          }
        }
        callback(allowed);
      };
      if (decision.action === "screen-picker") {
        // Granted only once the user picks a source; the display-media handler then shares that
        // pick (legacy desktop constraints capture right after this grant, without that handler).
        screenShareBroker
          .approve({ guestId: contents.id, origin, foreignOrigin: decision.foreignOrigin })
          .then((approved) => callback(approved === true), () => callback(false));
        return;
      }
      if (decision.action === "prompt") {
        permissionPrompter
          .request({ serviceId: service.id, serviceName: service.name, origin, keys: decision.keys })
          .then(answer);
        return;
      }
      answer(decision.action === "allow");
    } catch (error) {
      writeStartupDiagnostic(`Failed to decide the ${permission} permission.`, error);
      callback(false);
    }
  });

  targetSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      let contents = null;
      try {
        contents = request.frame ? webContents.fromFrame(request.frame) : null;
      } catch {
        contents = null;
      }
      if (!contents || !isSafeHttpUrl(request.securityOrigin)) {
        callback(DENY_SCREEN_SHARE);
        return;
      }
      // Uses the source picked when the permission was asked for; denies without a fresh pick.
      screenShareBroker.handleRequest(
        {
          guestId: contents.id,
          origin: originOf(request.securityOrigin),
          videoRequested: request.videoRequested,
          audioRequested: request.audioRequested
        },
        callback
      );
    },
    {
      // macOS 15+ shows its own picker after the broker's (macOS builds are not shipped).
      useSystemPicker: true
    }
  );

  configuredSessions.add(targetSession);
};

// Partition sessions are created and configured lazily by createView, never for unused services.
const configureKnownSessions = () => {
  configureSessionPermissions(session.defaultSession);
};

const flushSession = (targetSession) =>
  Promise.allSettled([targetSession.cookies.flushStore(), targetSession.flushStorageData()]);

const flushKnownSessions = async () => {
  await Promise.allSettled([...new Set(liveGuestSessions.values())].map(flushSession));
};

const isLiveWindow = (windowInstance) => Boolean(windowInstance && !windowInstance.isDestroyed());

// Every app-shell window, for sender checks. The static trigger page is included.
const getAllAppWindows = () =>
  [mainWindow, dockWindow, bubbleWindow, dockTriggerWindow].filter(isLiveWindow);

// Windows that render state; the trigger page does not.
const getBroadcastWindows = () => [mainWindow, dockWindow, bubbleWindow].filter(isLiveWindow);

const revealWindow = (windowInstance) => {
  if (!windowInstance || windowInstance.isDestroyed()) {
    return;
  }

  if (windowInstance.isMinimized()) {
    windowInstance.restore();
  }

  if (windowInstance !== mainWindow || !applyPendingMaximize()) windowInstance.show();
  windowInstance.moveTop();

  if (isLinux) {
    windowInstance.flashFrame(true);
    setTimeout(() => {
      if (!windowInstance.isDestroyed()) {
        windowInstance.flashFrame(false);
        windowInstance.focus();
      }
    }, 250);
    return;
  }

  windowInstance.focus();
};

/** Maximizes (which also shows) the main window once if it was saved maximized. */
const applyPendingMaximize = () => {
  if (!maximizeMainOnShow || !isLiveWindow(mainWindow)) return false;
  maximizeMainOnShow = false;
  mainWindow.maximize();
  return true;
};

const destroyAllWindows = () => {
  screenShareBroker.dispose();
  serviceManager?.dispose();
  frameStateQuery.dispose();
  desktopNotifier.dispose();
  clearInterval(onlineWatchTimer);
  onlineWatchTimer = null;
  serviceViewports.clear();
  stopDockVisibilityController();
  cancelDockTeardown();
  cancelMainTeardown();
  clearTimeout(bubbleResizeTimeout);
  bubbleResizeTimeout = null;
  for (const windowInstance of [bubbleWindow, dockTriggerWindow, dockWindow, mainWindow]) {
    if (windowInstance && !windowInstance.isDestroyed()) {
      windowInstance.destroy();
    }
  }
};

const requestAppQuit = () => {
  if (quitRequested || shutdownInProgress) {
    return;
  }

  quitRequested = true;
  app.quit();
};

const showFullApp = async () => {
  startHidden = false;
  setUiState({
    windowMode: "full",
    dockExpanded: true
  });
  broadcastState();
  await syncWindowMode();
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealWindow(mainWindow);
  }
  return getAppState();
};

// Brings the app back in its current mode: the expanded dock in dock mode, else the main window.
// Used for a second launch (D22), notification clicks (D3) and screen-share requests.
const revealApp = async () => {
  startHidden = false;
  if (getAppState().ui.windowMode === "dock" && supportsDockMode()) {
    cancelDockTeardown();
    setUiState({ dockExpanded: true });
    broadcastState();
    await syncWindowMode();
    if (isLiveWindow(bubbleWindow)) bubbleWindow.focus();
    return getAppState();
  }

  await syncWindowMode();
  revealWindow(mainWindow);
  return getAppState();
};

const isAppShell = (contents) => getAllAppWindows().some((window) => window.webContents === contents);

// Shell IPC is accepted only from the top frame of an app-shell window showing a shell document.
const isTrustedShellSender = (event) => {
  const frame = event?.senderFrame;
  return Boolean(frame) && !frame.parent && isAppShell(event.sender) && isShellDocumentUrl(frame.url);
};
const takeRejectedSenderLog = createRateLimiter({ count: 1, windowMs: 60000 });
const shellIpc = createShellIpc({
  ipcMain,
  isTrustedSender: isTrustedShellSender,
  onRejected: (channel) => {
    if (takeRejectedSenderLog(channel)) writeStartupDiagnostic(`Refused "${channel}" from a page that is not a Comms Hub window.`);
  }
});
const runtimeSnapshot = () => {
  const runtime = serviceManager?.getRuntimeState() ?? { services: {} };
  return {
    ...runtime,
    badgeCounts: badgeCountsFor({ services: getAppState().services, runtimeServices: runtime.services, titleCounts: titleBadgeCounts }),
    unseenNotificationCounts: notificationHistory.unseenCounts()
  };
};

// Broadcasts are coalesced: any number of changes in one tick produce at most one state and one
// runtime message per window, and a message identical to the last one sent is skipped.
let stateBroadcastScheduled = false;
let runtimeBroadcastScheduled = false;
let lastBroadcastState = null;
let lastSyncedState = null;
let lastRuntimeJson = "";

const trayController = createTrayController({
  getIcon: getTrayIcon,
  actions: {
    "open-full": () => showFullApp(),
    "show-dock": () => revealApp(),
    "enter-dock": async () => {
      startHidden = false;
      setUiState({ windowMode: "dock", dockExpanded: true });
      broadcastState();
      await syncWindowMode();
    },
    quit: () => requestAppQuit()
  },
  onActivate: () => showFullApp(),
  onError: (message, error) => writeStartupDiagnostic(message, error)
});
const trayView = (state = getAppState()) => ({
  windowMode: state.ui.windowMode,
  dockModeSupported: supportsDockMode()
});
const ensureTray = () => trayController.create(trayView());

/** Tray tooltip total, counted like the rail badges (D5): title count, else unseen notifications. */
const setTrayUnread = (count) => trayController.setUnread(count);
const refreshTrayUnread = (runtime = runtimeSnapshot()) =>
  setTrayUnread(countUnread({
    services: getAppState().services,
    badgeCounts: runtime.badgeCounts,
    unseenNotificationCounts: runtime.unseenNotificationCounts
  }));

const flushRuntimeBroadcast = () => {
  runtimeBroadcastScheduled = false;
  if (shutdownInProgress) return;
  const snapshot = runtimeSnapshot();
  refreshTrayUnread(snapshot);
  updateOnlineWatch(snapshot);
  const json = JSON.stringify(snapshot);
  if (json === lastRuntimeJson) return;
  lastRuntimeJson = json;
  for (const window of getBroadcastWindows()) window.webContents.send("services:runtime-updated", snapshot);
};
const broadcastRuntime = () => {
  if (runtimeBroadcastScheduled) return;
  runtimeBroadcastScheduled = true;
  setImmediate(flushRuntimeBroadcast);
};
const currentServiceHost = (state = getAppState()) =>
  state.ui.windowMode === "dock" && supportsDockMode() ? bubbleWindow : mainWindow;
const presentManagedService = () => {
  if (!serviceManager || shutdownInProgress) return;
  const state = getAppState();
  const host = currentServiceHost(state);
  const viewport = host && !host.isDestroyed() ? serviceViewports.get(host.webContents.id) : null;
  const valid = viewport && viewport.serviceId === state.ui.activeServiceId;
  serviceManager.setPresentation({
    host: valid ? host : null,
    bounds: valid ? viewport.bounds : null,
    obscured: !valid || viewport.obscured || !host.isVisible() || (state.ui.windowMode === "dock" && !state.ui.dockExpanded) ||
      // The in-app screen-share picker is shell DOM, so the native page must not cover it (D9).
      screenShareBroker.isPickerOpen(host.webContents.id),
    borderRadius: host === bubbleWindow ? 28 : 0
  });
};
const requestServiceViewport = () => {
  const host = currentServiceHost();
  if (host && !host.isDestroyed()) host.webContents.send("services:request-viewport");
};
const flushStateBroadcast = () => {
  stateBroadcastScheduled = false;
  if (shutdownInProgress) return;
  const state = getAppState();
  if (state !== lastBroadcastState) {
    lastBroadcastState = state;
    for (const windowInstance of getBroadcastWindows()) {
      windowInstance.webContents.send("state:updated", state);
    }
    // Every state change: the menu rebuilds only when what it shows changed.
    trayController.update(trayView(state));
    refreshTrayUnread();
  }
  requestServiceViewport();
};
// Applies the latest snapshot to the native views now; renderers get it on the next tick.
const broadcastState = () => {
  const state = getAppState();
  if (serviceManager && state !== lastSyncedState) {
    lastSyncedState = state;
    serviceManager.sync(state);
  }
  presentManagedService();
  if (stateBroadcastScheduled) return;
  stateBroadcastScheduled = true;
  setImmediate(flushStateBroadcast);
};
const requestActiveWebviewRefresh = () => serviceManager?.refreshActive() ?? false;

const markServiceSeen = (serviceId) => {
  if (notificationHistory.markSeen(serviceId)) broadcastRuntime();
};

// Runs on every window focus, so it must not write or broadcast when nothing is unseen.
const markActiveServiceSeen = () => {
  markServiceSeen(getAppState().ui.activeServiceId);
};

const findService = (serviceId) => getAppState().services.find((service) => service.id === serviceId) ?? null;

/** Selects an enabled service (else the first enabled one) and marks it seen. */
const selectService = (serviceId) => {
  const { services } = getAppState();
  const target = services.find((service) => service.id === serviceId && service.isEnabled);
  const nextServiceId = target?.id ?? services.find((service) => service.isEnabled)?.id ?? null;
  const state = setUiState({ activeServiceId: nextServiceId });
  markServiceSeen(nextServiceId);
  broadcastState();
  return state;
};

/** Saves a service's zoom (buttons, shortcuts, Ctrl+wheel); the service manager applies it. */
const setServiceZoom = (serviceId, zoomFactor) => {
  const service = findService(serviceId);
  if (!service) return getAppState();
  const state = upsertService({ ...service, zoomFactor: clampServiceZoom(zoomFactor) });
  broadcastState();
  return state;
};

const stepServiceZoom = (serviceId, direction) => {
  const service = findService(serviceId);
  if (service) setServiceZoom(service.id, stepZoomFactor(service.zoomFactor ?? 1, direction));
};

/** The address "Open in browser" uses: the live page, else where it was, else its home. */
const serviceBrowserUrl = (serviceId) => {
  const live = topLevelUrlOf(serviceManager?.getContents(serviceId));
  if (isSafeHttpUrl(live)) return live;
  const last = serviceManager?.getRuntimeState().services[serviceId]?.lastUrl;
  return isSafeHttpUrl(last) ? last : findService(serviceId)?.url ?? null;
};

const openServiceInBrowser = async (serviceId) => {
  const service = findService(serviceId);
  const url = service ? serviceBrowserUrl(serviceId) : null;
  if (!url) return false;
  return (await openExternalLink(url, { source: "navigate", serviceName: service.name })) === "opened";
};

const toggleActiveDevTools = () => {
  const contents = serviceManager?.getContents();
  if (!contents) return;
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  // A WebContentsView cannot host docked DevTools.
  else contents.openDevTools({ mode: "detach" });
};

const runShortcut = (shortcut) => {
  const state = getAppState();
  const activeId = state.ui.activeServiceId;
  switch (shortcut.action) {
    case "select": {
      const id = serviceIdAtIndex(state.services, shortcut.index);
      if (id && id !== activeId) selectService(id);
      break;
    }
    case "cycle": {
      const id = cycleServiceId(state.services, activeId, shortcut.direction);
      if (id && id !== activeId) selectService(id);
      break;
    }
    case "reload":
      serviceManager?.refreshActive({ ignoreCache: shortcut.ignoreCache });
      break;
    case "zoom":
      if (activeId) stepServiceZoom(activeId, shortcut.direction);
      break;
    case "find": {
      // The window hosting the selected service shows its find bar and takes the keyboard from
      // the page. A collapsed dock (hidden bubble) is expanded first.
      const host = currentServiceHost(state);
      const request = { serviceId: activeId };
      if (isLiveWindow(host) && host.isVisible()) {
        sendOverlayRequest(host, "ui:find-requested", request);
      } else {
        revealApp()
          .then(() => sendOverlayRequest(currentServiceHost(), "ui:find-requested", request))
          .catch((error) => writeStartupDiagnostic("The find shortcut failed.", error));
      }
      break;
    }
    case "back":
      serviceManager?.goBack();
      break;
    case "forward":
      serviceManager?.goForward();
      break;
    case "devtools":
      toggleActiveDevTools();
      break;
    case "settings":
      setUiState({ sidebarCollapsed: !state.ui.sidebarCollapsed });
      broadcastState();
      break;
    default:
      break;
  }
};

/** D11: one set of shortcuts for shell windows and service pages, handled before the page sees the key. */
const attachShortcuts = (contents) => {
  contents.on("before-input-event", (event, input) => {
    const shortcut = resolveShortcut(input);
    if (!shortcut) return;
    event.preventDefault();
    try {
      runShortcut(shortcut);
    } catch (error) {
      writeStartupDiagnostic(`The ${shortcut.action} shortcut failed.`, error);
    }
  });
};

/** Mouse back/forward buttons navigate the selected service. */
const runAppCommand = (_event, command) => {
  const action = resolveAppCommand(command);
  if (action === "back") serviceManager?.goBack();
  else if (action === "forward") serviceManager?.goForward();
};

/** Pops a native menu built from contextMenu.js descriptors; a click runs `actions[id](args)`. */
const popupMenu = (items, actions, window) => {
  if (!items.length || !isLiveWindow(window)) return false;
  const template = items.map(({ id, args, ...item }) =>
    item.type === "separator"
      ? { type: "separator" }
      : {
          ...item,
          click: () => {
            Promise.resolve()
              .then(() => actions[id]?.(args))
              .catch((error) => writeStartupDiagnostic(`The "${id}" menu action failed.`, error));
          }
        }
  );
  Menu.buildFromTemplate(template).popup({ window });
  return true;
};

const navigationOf = (contents) => {
  try {
    return { canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
};

// Actions for the page and shell menus; each acts on the page that was right-clicked.
const pageMenuActions = (contents) => ({
  "replace-misspelling": (word) => contents.replaceMisspelling(word),
  "add-to-dictionary": (word) => contents.session.addWordToSpellCheckerDictionary(word),
  undo: () => contents.undo(),
  redo: () => contents.redo(),
  cut: () => contents.cut(),
  copy: () => contents.copy(),
  paste: () => contents.paste(),
  "paste-plain": () => contents.pasteAndMatchStyle(),
  "select-all": () => contents.selectAll(),
  "open-link": (url) => openExternalLink(url, linkContextFor(contents)),
  "copy-text": (text) => clipboard.writeText(String(text ?? "")),
  "copy-image": ({ x, y }) => contents.copyImageAt(x, y),
  // Goes through will-download like any other download (D8).
  "save-image": (url) => contents.downloadURL(url),
  back: () => contents.navigationHistory.goBack(),
  forward: () => contents.navigationHistory.goForward(),
  reload: () => contents.reload(),
  "open-page": () => openExternalLink(contents.getURL(), linkContextFor(contents)),
  inspect: ({ x, y }) => {
    if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: "detach" });
    contents.inspectElement(x, y);
  }
});

const attachPageContextMenu = (contents, getWindow) => {
  contents.on("context-menu", (_event, params) => {
    try {
      popupMenu(buildGuestContextMenu(params, navigationOf(contents)), pageMenuActions(contents), getWindow());
    } catch (error) {
      writeStartupDiagnostic("Failed to show the page menu.", error);
    }
  });
};

const attachShellContextMenu = (windowInstance) => {
  const contents = windowInstance.webContents;
  contents.on("context-menu", (_event, params) => {
    try {
      popupMenu(buildShellContextMenu(params), pageMenuActions(contents), windowInstance);
    } catch (error) {
      writeStartupDiagnostic("Failed to show the edit menu.", error);
    }
  });
};

/** The rail's per-app menu (`services:context-menu`), popped on the window that asked. */
const showServiceContextMenu = (serviceId, window) => {
  const state = getAppState();
  const service = state.services.find((item) => item.id === serviceId);
  if (!service) return false;
  const runtime = serviceManager?.getRuntimeState().services[service.id] ?? null;
  const items = buildServiceRailMenu({
    service,
    runtime,
    isActive: state.ui.activeServiceId === service.id,
    hasPermissionDecisions: hasPermissionDecisions(service.id)
  });
  const update = (patch) => {
    const current = findService(serviceId);
    if (!current) return;
    upsertService({ ...current, ...patch(current) });
    broadcastState();
  };
  return popupMenu(items, {
    reload: () => {
      if (getAppState().ui.activeServiceId === serviceId) serviceManager?.refreshActive();
      else serviceManager?.getContents(serviceId)?.reload();
    },
    sleep: () => {
      sleepServiceAsking(serviceId).catch((error) => writeStartupDiagnostic("Failed to put an app to sleep.", error));
    },
    "keep-alive": () => update((current) => ({ keepAliveInBackground: !current.keepAliveInBackground })),
    "desktop-alerts": () =>
      update((current) => ({
        notificationSettings: {
          ...current.notificationSettings,
          desktopEnabled: current.notificationSettings?.desktopEnabled === false
        }
      })),
    // The editor is in the window hosting services: the dock rail has none, so its menu
    // expands the dock and opens the editor in the bubble.
    edit: async () => {
      let target = window;
      if (window === dockWindow) {
        await revealApp();
        target = currentServiceHost();
      }
      sendOverlayRequest(target, "ui:edit-service", { serviceId });
    },
    "open-in-browser": () => openServiceInBrowser(serviceId),
    "reset-permissions": () => {
      if (!clearPermissionDecisions(serviceId)) return;
      const name = findService(serviceId)?.name ?? "this app";
      sendStatusMessage(`Reset site permissions for ${name}. Other sites will ask again before using the camera, microphone or screen.`);
    },
    hide: () => update(() => ({ isEnabled: false, keepAliveInBackground: false })),
    remove: () => removeServiceWithConfirm(serviceId, window)
  }, window);
};

// Find in page (`services:find`): results go back to the window that asked.
const findTracker = createFindTracker();
const stopFindIn = (contentsId, action = "clearSelection") => {
  if (contentsId === null) return;
  try {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) contents.stopFindInPage(action);
  } catch (error) {
    writeStartupDiagnostic("Failed to stop find in page.", error);
  }
};
const forwardFindResult = (contents, result) => {
  const replyTo = findTracker.replyTargetFor(contents.id);
  if (!replyTo || replyTo.isDestroyed()) return;
  replyTo.send("services:find-result", {
    requestId: result?.requestId ?? null,
    activeMatchOrdinal: result?.activeMatchOrdinal ?? 0,
    matches: result?.matches ?? 0,
    finalUpdate: result?.finalUpdate === true
  });
};

/** Guest and popup pages: links that leave the app go through the link policy; popups per D13. */
const hardenGuestContents = (contents) => {
  contents.on("will-navigate", (event, url) => {
    if (isSafeHttpUrl(url)) return;
    // Cancel first, synchronously; the link policy decides what may leave the app.
    event.preventDefault();
    openExternalLink(url, linkContextFor(contents));
  });
  contents.setWindowOpenHandler(({ url, features }) => {
    const service = serviceForContents(contents);
    // A popup's own window.open() is judged against the service page that owns it.
    const wantsPopup = Boolean(service) &&
      decideWindowOpen({ url, openerUrl: guestTopLevelUrlOf(contents), serviceUrl: service.url }) === "popup";
    if (wantsPopup && popupGate.admit(service.id)) {
      return { action: "allow", overrideBrowserWindowOptions: {
        ...popupWindowOptions({ features, workArea: cursorWorkArea() }),
        icon: getAppIcon(),
        // Electron does not pass the opener's preload on, so a popup gets the guest preload (and
        // the same hardened settings) itself; its notifications then take the D3 path too.
        webPreferences: {
          preload: guestPreloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: true
        }
      } };
    }
    // Past the service's popup limits a blank window is refused; a page goes to the link policy.
    if (wantsPopup && isBlankPopupUrl(url)) return { action: "deny" };
    openExternalLink(url, linkContextFor(contents));
    return { action: "deny" };
  });
  contents.on("did-create-window", (popup, details) => {
    try {
      hardenPopup(popup, popupOwners.get(contents.id) ?? contents.id, details?.url);
    } catch (error) {
      writeStartupDiagnostic("Failed to set up a popup window; it was closed.", error);
      if (!popup.isDestroyed()) popup.destroy();
    }
  });
};

/** True when a navigation was started by a frame inside `contents` (its page or one of its frames). */
const initiatedInside = (details, contents) => {
  try {
    const frame = details?.initiator;
    return Boolean(frame) && webContents.fromFrame(frame)?.id === contents.id;
  } catch {
    return false;
  }
};

/** The work area of the display the user is on (the one nearest the cursor), or null. */
const cursorWorkArea = () => {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  } catch {
    return null;
  }
};

/**
 * A blank window shows whatever its opener writes into it, so only the service's own frames (and
 * the identity providers D13 trusts) may fill one: its first document must have their origin.
 */
const ownsBlankPopup = (contents, service) => {
  if (!service) return false;
  let origin = null;
  try {
    origin = contents.mainFrame?.origin ?? null;
  } catch {}
  return isServiceOwnedUrl({ url: origin, serviceUrl: service.url, aliases: ownedAliasesFor(contents, service) }) ||
    isIdentityProviderUrl(origin);
};

/** A child window keeps the opener's session and rules, and keeps the service awake until it closes. */
const hardenPopup = (popup, ownerId, initialUrl) => {
  const contents = popup.webContents;
  const contentsId = contents.id;
  popupOwners.set(contentsId, ownerId);
  const owner = serviceForContents(contents);
  const releaseSlot = owner ? popupGate.opened(owner.id) : () => {};
  popup.once("closed", () => {
    popupOwners.delete(contentsId);
    releaseSlot();
  });
  if (isBlankPopupUrl(initialUrl) && !ownsBlankPopup(contents, owner)) {
    popup.destroy();
    return;
  }
  const release = serviceManager?.protectPopup(ownerId) ?? (() => {});
  if (owner?.userAgent) contents.setUserAgent(owner.userAgent);
  // window.moveTo() and resizeTo() keep the popup inside the display it lands on.
  contents.on("content-bounds-updated", (event, bounds) => {
    event.preventDefault();
    try {
      if (!popup.isDestroyed()) popup.setBounds(clampPopupBounds(bounds, screen.getDisplayMatching(bounds).workArea));
    } catch {}
  });
  // window.open() followed by `popup.location = link` is a link, not a pop-out: the link goes to the
  // link policy (hardenGuestContents opens non-web schemes) and the blank window closes.
  let awaitingFirstPage = isBlankPopupUrl(initialUrl);
  contents.on("will-navigate", (event, url) => {
    const openerUrl = topLevelUrlOf(webContents.fromId(ownerId));
    const serviceUrl = owner?.url ?? null;
    let leaves;
    if (awaitingFirstPage) {
      awaitingFirstPage = false;
      leaves = blankPopupLeavesApp({ url, openerUrl, serviceUrl });
    } else {
      // Later, a web navigation the popup did not start itself (its opener or another window set
      // its location) is judged like a new window.open(); its own links and sign-in steps are left
      // alone. Other schemes are cancelled by hardenGuestContents and keep the popup open.
      leaves = isSafeHttpUrl(url) &&
        popupNavigationLeavesApp({ url, initiatedBySelf: initiatedInside(event, contents), ownerUrl: openerUrl, serviceUrl });
    }
    if (!leaves) return;
    if (isSafeHttpUrl(url)) {
      event.preventDefault();
      openExternalLink(url, linkContextFor(contents));
    }
    setImmediate(() => {
      if (!popup.isDestroyed()) popup.destroy();
    });
  });
  // The dock bubble floats above other windows; its popups belong to it so they stay visible.
  const host = currentServiceHost();
  if (host === bubbleWindow && isLiveWindow(host)) popup.setParentWindow(host);
  popup.setMenuBarVisibility(false);
  hardenGuestContents(contents);
  attachPageContextMenu(contents, () => popup);
  let shown = false;
  const show = () => {
    if (shown || popup.isDestroyed()) return;
    shown = true;
    popup.show();
  };
  popup.once("ready-to-show", show);
  const fallback = setTimeout(show, popupShowFallbackMs);
  popup.once("closed", () => {
    clearTimeout(fallback);
    release();
  });
};

/** The popup windows a service's page opened (its pop-outs and their own popups), oldest first. */
const popupWindowsOf = (serviceId) => {
  const guestId = serviceManager?.getContents(serviceId)?.id;
  if (guestId === undefined) return [];
  return [...popupOwners]
    .filter(([, ownerId]) => ownerId === guestId)
    .map(([id]) => {
      const contents = webContents.fromId(id);
      return contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
    })
    .filter((window) => window && !window.isDestroyed());
};

// Closes a window the way its close button does, so its page's beforeunload can keep it open.
// Resolves true once it has closed, false when the page kept it open or did not answer in time.
const closeWindowAsking = (window, timeoutMs = 5000) => new Promise((resolve) => {
  if (window.isDestroyed()) {
    resolve(true);
    return;
  }
  const contents = window.webContents;
  let timer = null;
  const finish = (closed) => {
    clearTimeout(timer);
    window.removeListener("closed", onClosed);
    contents.removeListener("will-prevent-unload", onVeto);
    resolve(closed);
  };
  const onClosed = () => finish(true);
  const onVeto = () => finish(false);
  timer = setTimeout(() => finish(window.isDestroyed()), timeoutMs);
  window.once("closed", onClosed);
  contents.once("will-prevent-unload", onVeto);
  window.close();
});

/**
 * "Sleep now" (D16). Sleeping an app destroys its popup windows, so with any open the user is
 * asked first; on yes they are closed newest first, each page may keep its window open
 * (beforeunload), and the app sleeps only once all have closed. Resolves true when it is asleep,
 * false when it cannot sleep now, and null when the user said no.
 */
const sleepServiceAsking = async (serviceId) => {
  const popups = popupWindowsOf(serviceId);
  if (popups.length && getAppState().ui.activeServiceId !== serviceId) {
    const name = getAppState().services.find((service) => service.id === serviceId)?.name ?? "This app";
    const { response } = await showMessageBox({
      type: "question",
      buttons: ["Close windows and sleep", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Put app to sleep",
      message: `Close ${name}'s open ${popups.length === 1 ? "window" : "windows"} and put it to sleep?`,
      detail: `${name} has ${popups.length === 1 ? "a pop-out window" : `${popups.length} pop-out windows`} open. ` +
        "They are closed first. If one won't close (for example, it holds an unsent message), the app stays awake."
    });
    if (response !== 0) return null;
    for (const popup of popups.reverse()) {
      if (!(await closeWindowAsking(popup))) return false;
    }
  }
  return serviceManager?.sleep(serviceId) ?? false;
};

const waitForSessionRelease = async (targetSession, timeoutMs = 3000) => {
  const end = Date.now() + timeoutMs;
  while ([...liveGuestSessions.values()].includes(targetSession) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Signs the removed app out and drops its caches. Never called for the default session. */
const wipePartitionData = async (partition) => {
  const targetSession = session.fromPartition(partition);
  // A page that is still closing could write storage again after the wipe.
  await waitForSessionRelease(targetSession);
  const results = await Promise.allSettled([
    targetSession.clearStorageData(),
    targetSession.clearCache(),
    targetSession.clearCodeCaches({}),
    targetSession.clearAuthCache()
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) writeStartupDiagnostic("Failed to delete some data of a removed app.", failure.reason);
};

/**
 * D7: asks first (native confirm with an unchecked "also delete its sign-in data" box). Resolves
 * the new state, the unchanged state for apps that cannot be removed, or null when cancelled.
 */
const removeServiceWithConfirm = async (serviceId, parent) => {
  const before = getAppState();
  const target = before.services.find((service) => service.id === serviceId);
  if (!target || target.isBuiltIn) return before;
  const plan = removalPlan({ target, services: before.services, iconsDir: getIconsDirectory(), platform: pathPlatform });
  const { response, checkboxChecked } = await showMessageBox(
    removeConfirmOptions({ name: target.name, canWipeData: Boolean(plan.partition) }),
    isLiveWindow(parent) ? parent : visibleServiceHost()
  );
  if (response !== 0) return null;
  if (!findService(serviceId)) return getAppState();

  const state = removeService(serviceId);
  titleBadgeCounts.delete(serviceId);
  desktopNotifier.forgetService(serviceId);
  if (notificationHistory.forgetService(serviceId)) broadcastRuntime();
  // Releases the page before its data is touched.
  broadcastState();
  if (plan.iconPath && unusedIconFile(target.iconSource, { services: state.services, iconsDir: getIconsDirectory(), platform: pathPlatform })) {
    fs.promises.unlink(plan.iconPath).catch(() => {});
  }
  if (
    checkboxChecked === true && plan.partition &&
    !state.services.some((service) => !service.useDefaultSession && service.sessionPartition === plan.partition)
  ) {
    await wipePartitionData(plan.partition);
  }
  return getAppState();
};

const getDockBounds = (ui = getAppState().ui) => {
  const workArea = screen.getPrimaryDisplay().workArea;
  return getDockBoundsForWorkArea({
    workArea,
    corner: ui.dockCorner,
    height: clampDockHeight(ui.dockHeight),
    dock: dockWindowSize.dock
  });
};

const normalizeUnsupportedDockMode = () => {
  if (supportsDockMode()) {
    return getAppState();
  }

  const state = getAppState();
  if (state.ui.windowMode !== "dock") {
    return state;
  }

  return setUiState({ windowMode: "full", dockExpanded: true });
};

const getDockTriggerBounds = (ui = getAppState().ui) => {
  const dockBounds = getDockBounds(ui);
  const workArea = screen.getPrimaryDisplay().workArea;
  const rightAnchored = ui.dockCorner === "top-right" || ui.dockCorner === "bottom-right";
  const width = Math.min(dockTriggerSize.width, Math.max(1, workArea.width - WINDOW_SIDE_INSET * 2));
  const height = Math.min(dockTriggerSize.height, dockBounds.height);
  const y = Math.round(dockBounds.y + (dockBounds.height - height) / 2);

  return {
    width,
    height,
    x: rightAnchored
      ? workArea.x + workArea.width - width - WINDOW_SIDE_INSET
      : workArea.x + WINDOW_SIDE_INSET,
    y
  };
};

const getBubbleBounds = (ui = getAppState().ui) => {
  const workArea = screen.getPrimaryDisplay().workArea;
  const dockBounds = getDockBounds(ui);
  return getBubbleBoundsForWorkArea({
    workArea,
    dockBounds,
    corner: ui.dockCorner,
    preferredSize: ui.bubbleSize ?? dockWindowSize.bubble
  });
};

const applyDockBounds = () => {
  if (!supportsDockMode() || !dockWindow || dockWindow.isDestroyed()) {
    return;
  }

  const bounds = getDockBounds();
  const current = dockWindow.getBounds();
  if (current.width !== bounds.width || current.height !== bounds.height) {
    dockWindow.setMinimumSize(bounds.width, bounds.height);
    dockWindow.setMaximumSize(bounds.width, bounds.height);
  }
  applyBoundsIfChanged(dockWindow, bounds);
};

const applyBubbleBounds = () => {
  if (!supportsDockMode() || !bubbleWindow || bubbleWindow.isDestroyed()) {
    return;
  }

  const bounds = getBubbleBounds();
  const constraints = getBubbleConstraints(screen.getPrimaryDisplay().workArea, getDockBounds().width);
  bubbleWindow.setMinimumSize(constraints.minWidth, constraints.minHeight);
  bubbleWindow.setMaximumSize(constraints.maxWidth, constraints.maxHeight);
  applyBoundsIfChanged(bubbleWindow, bounds);
};

const applyDockTriggerBounds = () => {
  if (!supportsDockMode() || !dockTriggerWindow || dockTriggerWindow.isDestroyed()) {
    return;
  }

  const bounds = getDockTriggerBounds();
  dockTriggerWindow.setMinimumSize(bounds.width, bounds.height);
  dockTriggerWindow.setMaximumSize(bounds.width, bounds.height);
  applyBoundsIfChanged(dockTriggerWindow, bounds);
};

const clearDockHideTimeout = () => {
  if (dockHideTimeout) {
    clearTimeout(dockHideTimeout);
    dockHideTimeout = null;
  }
};

const hideDockTriggerWindow = () => {
  setUtilityWindowVisibility(dockTriggerWindow, false);
};

const showDockTriggerWindow = () => {
  if (!dockTriggerWindow || dockTriggerWindow.isDestroyed()) {
    return;
  }

  configureFloatingUtilityWindow(dockTriggerWindow);
  if (!dockTriggerWindow.isVisible()) {
    applyDockTriggerBounds();
    setUtilityWindowVisibility(dockTriggerWindow, true);
  }
};

const showDockWindow = () => {
  if (!dockWindow || dockWindow.isDestroyed()) {
    return;
  }

  configureFloatingUtilityWindow(dockWindow);
  if (!dockWindow.isVisible()) {
    applyDockBounds();
    setUtilityWindowVisibility(dockWindow, true);
  }
};

const hideDockWindow = () => {
  setUtilityWindowVisibility(dockWindow, false);
};

const showBubbleWindow = () => {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    return;
  }

  configureFloatingUtilityWindow(bubbleWindow);
  if (!bubbleWindow.isVisible()) {
    applyBubbleBounds();
    setUtilityWindowVisibility(bubbleWindow, true);
  }
};

const hideBubbleWindow = () => {
  setUtilityWindowVisibility(bubbleWindow, false);
};

const configureFloatingUtilityWindow = (windowInstance) => {
  if (!supportsDockMode()) {
    return;
  }
  configureUtilityWindowOnce(windowInstance);
};

const hideDockToTrigger = () => {
  clearDockHideTimeout();
  hideBubbleWindow();
  hideDockWindow();
  showDockTriggerWindow();
};

const revealDockFromTrigger = async (ui = getAppState().ui) => {
  if (!supportsDockMode()) {
    return;
  }
  clearDockHideTimeout();

  if (!dockWindow || dockWindow.isDestroyed()) {
    await createDockWindow();
  }

  showDockWindow();
  hideDockTriggerWindow();

  if (ui.dockExpanded) {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) {
      await createBubbleWindow();
    }
    showBubbleWindow();
  } else {
    hideBubbleWindow();
  }
};

const isDockSurfaceFocused = () =>
  [dockWindow, bubbleWindow].some((windowInstance) => isLiveWindow(windowInstance) && windowInstance.isFocused());

const getDockVisibilityPlan = (ui) =>
  planDockVisibility({
    dockModeSupported: supportsDockMode(),
    windowMode: ui.windowMode,
    dockExpanded: ui.dockExpanded,
    dockSurfaceFocused: isDockSurfaceFocused()
  });

const performDockVisibilitySync = async () => {
  const { ui } = getAppState();
  const plan = getDockVisibilityPlan(ui);

  if (plan === "hide-all") {
    clearDockHideTimeout();
    hideDockTriggerWindow();
    hideDockWindow();
    hideBubbleWindow();
    return;
  }

  if (plan === "reveal") {
    await revealDockFromTrigger(ui);
    return;
  }

  if (plan === "collapse" && !dockHideTimeout) {
    dockHideTimeout = setTimeout(() => {
      dockHideTimeout = null;
      try {
        if (getDockVisibilityPlan(getAppState().ui) === "collapse") hideDockToTrigger();
      } catch (error) {
        writeStartupDiagnostic("Failed to collapse the dock.", error);
      }
    }, dockHideDelayMs);
  }
};

const syncDockVisibility = createCoalescedAsyncRunner(performDockVisibilitySync);

const stopDockVisibilityController = () => {
  clearDockHideTimeout();
};

const cancelDockTeardown = () => {
  clearTimeout(dockTeardownTimer);
  dockTeardownTimer = null;
};

// Destroys the dock-mode windows once the user has stayed out of dock mode for a while.
const teardownDockWindows = () => {
  dockTeardownTimer = null;
  if (shutdownInProgress || getAppState().ui.windowMode === "dock") {
    return;
  }

  // Guest views must be back on the main window, and its popups closed, before the bubble goes away.
  presentManagedService();
  if (isLiveWindow(bubbleWindow) && (bubbleWindow.contentView.children.length > 0 || bubbleWindow.getChildWindows().length > 0)) {
    scheduleDockTeardown();
    return;
  }

  for (const windowInstance of [dockTriggerWindow, dockWindow, bubbleWindow]) {
    if (isLiveWindow(windowInstance)) windowInstance.destroy();
  }
};

const scheduleDockTeardown = () => {
  if (dockTeardownTimer || ![dockTriggerWindow, dockWindow, bubbleWindow].some(isLiveWindow)) {
    return;
  }
  dockTeardownTimer = setTimeout(teardownDockWindows, dockTeardownDelayMs);
};

const cancelMainTeardown = () => {
  clearTimeout(mainTeardownTimer);
  mainTeardownTimer = null;
};

// Dock mode keeps no hidden full renderer: once the pages and popups have left the main window,
// it is destroyed (full mode creates it again on demand).
const teardownMainWindow = () => {
  mainTeardownTimer = null;
  if (shutdownInProgress || !isLiveWindow(mainWindow) || !supportsDockMode() || getAppState().ui.windowMode !== "dock") {
    return;
  }
  if (mainWindow.contentView.children.length > 0 || mainWindow.getChildWindows().length > 0) {
    scheduleMainTeardown();
    return;
  }
  saveMainWindowState();
  mainWindow.destroy();
};

const scheduleMainTeardown = () => {
  if (mainTeardownTimer || !isLiveWindow(mainWindow)) {
    return;
  }
  mainTeardownTimer = setTimeout(teardownMainWindow, mainTeardownDelayMs);
};

const restoreDockWindows = () => {
  const state = getAppState();
  if (!supportsDockMode() || state.ui.windowMode !== "dock") {
    return;
  }

  if (dockTriggerWindow && !dockTriggerWindow.isDestroyed()) {
    applyDockTriggerBounds();
    configureFloatingUtilityWindow(dockTriggerWindow);
  }

  if (dockWindow && !dockWindow.isDestroyed()) {
    applyDockBounds();
    configureFloatingUtilityWindow(dockWindow);
  }

  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    applyBubbleBounds();
    configureFloatingUtilityWindow(bubbleWindow);
  }

  syncDockVisibility().catch(() => {});
};

// Shell windows never leave their own document; a navigation away (a dropped link, an injected
// script) is cancelled so no foreign page ever gets the commsApp bridge.
const lockShellNavigation = (contents) => {
  const block = (event, url) => {
    if (isShellDocumentUrl(url)) return;
    event.preventDefault();
    writeStartupDiagnostic(`Blocked a Comms Hub window from navigating to ${String(url).slice(0, 200)}.`);
  };
  contents.on("will-frame-navigate", (event) => block(event, event.url));
  contents.on("will-redirect", (event, url) => block(event, event.url ?? url));
};

// A crashed or killed shell renderer is reloaded, at most 3 times a minute per window.
const takeShellReload = createRateLimiter({ count: 3, windowMs: 60000 });

// `reload` loads the window's page again after its renderer died.
const attachSharedWindowBehavior = (windowInstance, { interactive = true, reload = null } = {}) => {
  const contents = windowInstance.webContents;
  const contentsId = contents.id;
  contents.setZoomFactor(1);
  contents.on("render-process-gone", (_event, details) => {
    if (shutdownInProgress || details?.reason === "clean-exit" || windowInstance.isDestroyed()) return;
    writeStartupDiagnostic(`A Comms Hub window's renderer stopped (${details?.reason ?? "unknown"}).`);
    if (!reload || !takeShellReload(contentsId)) return;
    Promise.resolve()
      .then(reload)
      .catch((error) => writeStartupDiagnostic("Failed to reload a Comms Hub window.", error));
  });
  // Windows may end the session without a normal quit; keep the latest settings. Every shell
  // window listens, since dock mode has no main window.
  windowInstance.on("session-end", () => {
    saveMainWindowState();
    flushPendingWrites();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, { source: "shell" });
    return { action: "deny" };
  });
  lockShellNavigation(contents);
  if (interactive) {
    attachShortcuts(contents);
    attachShellContextMenu(windowInstance);
    windowInstance.on("app-command", runAppCommand);
  }
  // A reloaded renderer must subscribe its screen-share picker again; open requests are cancelled.
  contents.on("did-navigate", () => {
    screenSharePickers.delete(contentsId);
    screenShareBroker.cancelForHost(contentsId);
  });

  windowInstance.on("closed", () => {
    screenSharePickers.delete(contentsId);
    pendingOverlayRequests.delete(contentsId);
    screenShareBroker.cancelForHost(contentsId);
    for (const [id, viewport] of serviceViewports) {
      if (viewport.windowId === windowInstance.id) serviceViewports.delete(id);
    }
  });
  // No "resize" hook: the renderer reports its viewport after layout on its own.
  windowInstance.setMenuBarVisibility(false);
  windowInstance.on("close", (event) => {
    if (shutdownInProgress) {
      flushKnownSessions().catch(() => {});
      return;
    }
    // D2: the dock, bubble and trigger ignore close (e.g. Alt+F4); only the main window reacts.
    if (windowInstance !== mainWindow) {
      event.preventDefault();
      return;
    }
    if (process.platform === "darwin") {
      saveMainWindowState();
      flushKnownSessions().catch(() => {});
      return;
    }

    event.preventDefault();
    // Close quits by default; hiding to the tray is opt-in and needs a tray to come back from.
    if (getAppState().ui.closeToTray && trayController.isActive()) {
      windowInstance.hide();
      return;
    }
    requestAppQuit();
  });
  windowInstance.on("focus", () => {
    markActiveServiceSeen();
    syncDockVisibility().catch(() => {});
  });
  windowInstance.on("blur", () => {
    syncDockVisibility().catch(() => {});
  });
  windowInstance.on("show", () => {
    presentManagedService();
    requestServiceViewport();
    syncDockVisibility().catch(() => {});
  });
  windowInstance.on("hide", () => {
    presentManagedService();
    syncDockVisibility().catch(() => {});
  });
};

// Never throws: it also runs inside before-quit.
const saveMainWindowState = () => {
  clearTimeout(mainWindowStateTimer);
  mainWindowStateTimer = null;
  try {
    // Minimized and full-screen bounds are not what the user wants back next launch.
    if (!isLiveWindow(mainWindow) || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
    // A window that was never shown still owes its saved maximize (maximizeMainOnShow).
    setMainWindowState({ ...mainWindow.getNormalBounds(), isMaximized: mainWindow.isMaximized() || maximizeMainOnShow });
  } catch (error) {
    writeStartupDiagnostic("Failed to save the main window position.", error);
  }
};

const scheduleMainWindowStateSave = () => {
  clearTimeout(mainWindowStateTimer);
  mainWindowStateTimer = setTimeout(saveMainWindowState, mainWindowStateSaveDelayMs);
};

const loadRendererIntoWindow = async (windowInstance, mode = "full") => {
  const distEntry = distEntryPath;

  if (isDev) {
    try {
      await windowInstance.loadURL(`${devServerOrigin}/?mode=${mode}`);
      if (mode === "full") {
        windowInstance.webContents.openDevTools({ mode: "detach" });
      }
    } catch (error) {
      console.error("Failed to load dev server, falling back to dist build.", error);
      await windowInstance.loadFile(distEntry, { query: { mode } });
    }
  } else {
    await windowInstance.loadFile(distEntry, { query: { mode } });
  }
};

const createMainWindow = async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  const placement = restoreWindowBounds({
    saved: getMainWindowState(),
    workAreas: screen.getAllDisplays().map((display) => display.workArea),
    primaryWorkArea: screen.getPrimaryDisplay().workArea
  });
  maximizeMainOnShow = placement.isMaximized;
  mainWindow = new BrowserWindow({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    minWidth: MAIN_WINDOW_MIN_SIZE.width,
    minHeight: MAIN_WINDOW_MIN_SIZE.height,
    title: "Comms Hub",
    icon: getAppIcon(),
    backgroundColor: "#08111d",
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "win32" ? "hidden" : "default",
    titleBarOverlay:
      process.platform === "win32"
        ? {
            color: "#08111d",
            symbolColor: "#e5eefc",
            height: 40
          }
        : false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  const createdMainWindow = mainWindow;
  attachSharedWindowBehavior(mainWindow, { reload: () => loadRendererIntoWindow(createdMainWindow, "full") });
  // The taskbar button (and its overlay) only exists while the window is shown.
  mainWindow.on("show", () => {
    if (overlayBadge) applyOverlayBadge();
  });
  for (const eventName of ["resize", "move", "maximize", "unmaximize"]) {
    mainWindow.on(eventName, scheduleMainWindowStateSave);
  }
  mainWindow.on("closed", () => {
    clearTimeout(mainWindowStateTimer);
    mainWindowStateTimer = null;
    if (mainWindow === createdMainWindow) mainWindow = null;
  });
  await loadRendererIntoWindow(createdMainWindow, "full");
  return createdMainWindow;
};

const createDockWindow = async () => {
  if (!supportsDockMode()) {
    return null;
  }
  if (dockWindowCreation) {
    return dockWindowCreation;
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    return dockWindow;
  }

  dockWindowCreation = (async () => {
    const bounds = getDockBounds();
    const dockHeight = bounds.height;
    const nextDockWindow = new BrowserWindow({
      ...bounds,
      minWidth: bounds.width,
      minHeight: dockHeight,
      maxWidth: bounds.width,
      maxHeight: dockHeight,
      title: "Comms Hub Dock",
      icon: getAppIcon(),
      frame: false,
      resizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: "#00000000",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });

    dockWindow = nextDockWindow;
    attachSharedWindowBehavior(nextDockWindow, { reload: () => loadRendererIntoWindow(nextDockWindow, "dock") });
    configureFloatingUtilityWindow(nextDockWindow);
    nextDockWindow.on("closed", () => {
      if (dockWindow === nextDockWindow) {
        dockWindow = null;
      }
    });
    await loadRendererIntoWindow(nextDockWindow, "dock");
    return nextDockWindow;
  })().finally(() => {
    dockWindowCreation = null;
  });

  return dockWindowCreation;
};

// The trigger is a static page (no React, no state broadcasts). It learns its anchoring side from
// the query string and is reloaded when the dock corner changes.
const loadDockTriggerPage = async (windowInstance) => {
  const corner = normalizeDockCorner(getAppState().ui.dockCorner);
  dockTriggerCorner = corner;
  await windowInstance.loadFile(triggerPagePath, { query: { corner } });
};

const refreshDockTriggerCorner = () => {
  if (isLiveWindow(dockTriggerWindow) && !dockTriggerWindowCreation && dockTriggerCorner !== getAppState().ui.dockCorner) {
    loadDockTriggerPage(dockTriggerWindow).catch((error) => {
      writeStartupDiagnostic("Failed to reload the dock trigger.", error);
    });
  }
};

const createDockTriggerWindow = async () => {
  if (!supportsDockMode()) {
    return null;
  }
  if (dockTriggerWindowCreation) {
    return dockTriggerWindowCreation;
  }
  if (dockTriggerWindow && !dockTriggerWindow.isDestroyed()) {
    return dockTriggerWindow;
  }

  dockTriggerWindowCreation = (async () => {
    const bounds = getDockTriggerBounds();
    const nextDockTriggerWindow = new BrowserWindow({
      ...bounds,
      minWidth: bounds.width,
      minHeight: bounds.height,
      maxWidth: bounds.width,
      maxHeight: bounds.height,
      title: "Comms Hub Dock Trigger",
      icon: getAppIcon(),
      frame: false,
      resizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: "#00000000",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });

    dockTriggerWindow = nextDockTriggerWindow;
    attachSharedWindowBehavior(nextDockTriggerWindow, {
      interactive: false,
      reload: () => loadDockTriggerPage(nextDockTriggerWindow)
    });
    configureFloatingUtilityWindow(nextDockTriggerWindow);
    nextDockTriggerWindow.on("closed", () => {
      if (dockTriggerWindow === nextDockTriggerWindow) {
        dockTriggerWindow = null;
        dockTriggerCorner = null;
      }
    });
    await loadDockTriggerPage(nextDockTriggerWindow);
    return nextDockTriggerWindow;
  })().finally(() => {
    dockTriggerWindowCreation = null;
    refreshDockTriggerCorner(); // the corner may have changed while the page was loading
  });

  return dockTriggerWindowCreation;
};

const createBubbleWindow = async () => {
  if (!supportsDockMode()) {
    return null;
  }
  if (bubbleWindowCreation) {
    return bubbleWindowCreation;
  }
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    return bubbleWindow;
  }

  bubbleWindowCreation = (async () => {
    const bounds = getBubbleBounds();
    const constraints = getBubbleConstraints(screen.getPrimaryDisplay().workArea, getDockBounds().width);
    const nextBubbleWindow = new BrowserWindow({
      ...bounds,
      minWidth: constraints.minWidth,
      minHeight: constraints.minHeight,
      maxWidth: constraints.maxWidth,
      maxHeight: constraints.maxHeight,
      title: "Comms Hub Bubble",
      icon: getAppIcon(),
      frame: false,
      resizable: true,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: false,
      backgroundColor: "#08111d",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });

    bubbleWindow = nextBubbleWindow;
    attachSharedWindowBehavior(nextBubbleWindow, { reload: () => loadRendererIntoWindow(nextBubbleWindow, "bubble") });
    configureFloatingUtilityWindow(nextBubbleWindow);
    // will-resize is emitted for user resizing on supported dock platforms, not setBounds.
    // Capture the user's preference here so display clamping never overwrites it.
    nextBubbleWindow.on("will-resize", (_event, requestedBounds) => {
      const preferredSize = normalizePreferredBubbleSize(requestedBounds);
      clearTimeout(bubbleResizeTimeout);
      bubbleResizeTimeout = setTimeout(() => {
        bubbleResizeTimeout = null;
        if (nextBubbleWindow.isDestroyed()) return;
        setUiState({ bubbleSize: preferredSize });
        broadcastState();
        applyBubbleBounds();
      }, 180);
    });
    nextBubbleWindow.on("closed", () => {
      if (bubbleWindow === nextBubbleWindow) {
        bubbleWindow = null;
      }
    });
    await loadRendererIntoWindow(nextBubbleWindow, "bubble");
    return nextBubbleWindow;
  })().finally(() => {
    bubbleWindowCreation = null;
  });

  return bubbleWindowCreation;
};

// Dock mode never creates the main window (a hidden full renderer that would get every
// broadcast), and one left from full mode is destroyed a minute later; switching to full mode,
// or anything else that needs it, creates it on demand.
const performWindowModeSync = async () => {
  const { windowMode } = getAppState().ui;

  if (supportsDockMode() && windowMode === "dock") {
    cancelDockTeardown();
    if (!dockTriggerWindow || dockTriggerWindow.isDestroyed()) {
      await createDockTriggerWindow();
    } else {
      applyDockTriggerBounds();
    }

    if (!dockWindow || dockWindow.isDestroyed()) {
      await createDockWindow();
    } else {
      applyDockBounds();
    }

    if (getAppState().ui.dockExpanded) {
      if (!bubbleWindow || bubbleWindow.isDestroyed()) {
        await createBubbleWindow();
      } else {
        applyBubbleBounds();
      }
    }

    await syncDockVisibility();
    if (isLiveWindow(mainWindow)) {
      mainWindow.hide();
      scheduleMainTeardown();
    }
    return;
  }

  cancelMainTeardown();
  if (!isLiveWindow(mainWindow)) {
    await createMainWindow();
  }
  stopDockVisibilityController();
  hideDockTriggerWindow();
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.hide();
  }
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.hide();
  }
  scheduleDockTeardown();

  // A hidden start leaves the app in the tray; any later pass (or a reveal) shows the window.
  // The native hide() matters: a never-shown window's page still reports itself visible, so
  // it would poll metrics and run unthrottled.
  if (startHidden) {
    mainWindow.hide();
    return;
  }
  if (!mainWindow.isVisible() && !applyPendingMaximize()) {
    mainWindow.show();
  }
  mainWindow.focus();
};

const syncWindowMode = createCoalescedAsyncRunner(async () => {
  await performWindowModeSync();
  serviceManager?.sync(getAppState());
  presentManagedService();
  requestServiceViewport();
});

const initializeServiceManager = () => {
  serviceManager = createServiceManager({
    createView: (service) => {
      const targetSession = service.useDefaultSession ? session.defaultSession : session.fromPartition(service.sessionPartition);
      configureSessionPermissions(targetSession);
      const view = new WebContentsView({ webPreferences: {
        session: targetSession,
        preload: guestPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      } });
      const contents = view.webContents;
      const contentsId = contents.id;
      liveGuestSessions.set(contentsId, targetSession);
      contents.once("destroyed", () => {
        liveGuestSessions.delete(contentsId);
        findTracker.forget(contentsId);
        // A page put to sleep may never be flushed by the periodic pass, so flush it once now.
        if (!shutdownInProgress) flushSession(targetSession).catch(() => {});
      });
      contents.setUserAgent(service.userAgent || getGuestUserAgent());
      hardenGuestContents(contents);
      attachPageContextMenu(contents, () => currentServiceHost());
      attachShortcuts(contents);
      // Ctrl+wheel: Electron reports it but leaves zooming to the app, so it is saved like the buttons.
      contents.on("zoom-changed", (_event, direction) => {
        const owner = serviceForContents(contents);
        if (owner) stepServiceZoom(owner.id, direction === "in" ? 1 : -1);
      });
      contents.on("found-in-page", (_event, result) => forwardFindResult(contents, result));
      return view;
    },
    onRuntimeChanged: broadcastRuntime,
    // Titles feed the unread badge only; they never raise a toast (D4).
    onTitle: (serviceId, title, webContentsId) => {
      try {
        const service = getAppState().services.find((item) => item.id === serviceId);
        if (!service) return;
        const count = parseBadgeCount(title, service);
        // No count in this title (a thread view, a flashing "X messaged you"): keep the last one.
        if (count === null) return;
        const previous = titleBadgeCounts.get(serviceId);
        if (previous?.count === count && previous.webContentsId === webContentsId) return;
        titleBadgeCounts.set(serviceId, { count, webContentsId });
        broadcastRuntime();
      } catch (error) {
        writeStartupDiagnostic(`Failed to process a title update for ${serviceId}.`, error);
      }
    },
    queryFrames: (contents, keys) => frameStateQuery.query(frameTargetsFor(contents, keys)),
    onError: (serviceId, error) => console.error(`Service ${serviceId}:`, error)
  });
  serviceManager.sync(getAppState());
};

// Failed loads are retried on a backoff by the service manager; these make it happen sooner when
// the machine wakes up or the network comes back.
const retryFailedServices = () => {
  try {
    serviceManager?.retryFailed();
  } catch (error) {
    writeStartupDiagnostic("Failed to retry services after a network change.", error);
  }
};
const isOnline = () => {
  try {
    return net.isOnline();
  } catch {
    return true;
  }
};
const updateOnlineWatch = (runtime) => {
  const waiting = Object.values(runtime.services ?? {}).some((service) => service.retryAt !== null && service.retryAt !== undefined);
  if (!waiting) {
    clearInterval(onlineWatchTimer);
    onlineWatchTimer = null;
    return;
  }
  if (onlineWatchTimer) return;
  lastKnownOnline = isOnline();
  onlineWatchTimer = setInterval(() => {
    const online = isOnline();
    if (online && !lastKnownOnline) retryFailedServices();
    lastKnownOnline = online;
  }, onlineWatchIntervalMs);
  onlineWatchTimer.unref?.();
};
// Optional: without these events the backoff timers still retry, so a failure must not stop startup.
const watchPowerEvents = () => {
  try {
    // The network usually needs a few seconds after resume.
    powerMonitor.on("resume", () => setTimeout(retryFailedServices, 5000));
    powerMonitor.on("unlock-screen", retryFailedServices);
  } catch (error) {
    writeStartupDiagnostic("Power events are unavailable; failed loads retry on their timers only.", error);
  }
};

// Every app-shell channel goes through shellIpc, which refuses other senders.
shellIpc.handle("services:get-runtime", () => runtimeSnapshot());
shellIpc.handle("services:set-zoom", (_event, { serviceId, zoomFactor } = {}) => setServiceZoom(serviceId, zoomFactor));
shellIpc.on("services:set-viewport", (event, viewport) => {
  const state = getAppState();
  const host = currentServiceHost(state);
  if (!host || host.isDestroyed() || host.webContents !== event.sender || viewport?.serviceId !== state.ui.activeServiceId) return;
  const supplied = viewport.bounds;
  if (!supplied || ![supplied.x, supplied.y, supplied.width, supplied.height].every(Number.isFinite)) return;
  const [width, height] = host.getContentSize();
  const x = Math.max(0, Math.min(width, Math.round(supplied.x)));
  const y = Math.max(0, Math.min(height, Math.round(supplied.y)));
  const right = Math.max(x, Math.min(width, Math.round(supplied.x + supplied.width)));
  const bottom = Math.max(y, Math.min(height, Math.round(supplied.y + supplied.height)));
  serviceViewports.set(event.sender.id, {
    windowId: host.id, serviceId: viewport.serviceId,
    bounds: { x, y, width: right - x, height: bottom - y },
    obscured: Boolean(viewport.obscured) || right <= x || bottom <= y
  });
  presentManagedService();
});
// Guest preload channels (D3, D17). Only pages owned by the service manager are listened to, and
// state is kept per frame so one frame's report never clears another's.
const frameStateQuery = createFrameStateQuery();
const guestFrameKey = (event) => (serviceManager?.getServiceIdForContents(event.sender.id) ? frameKeyOf(event.senderFrame) : null);

ipcMain.on("guest:edited", (event, dirty) => {
  const key = guestFrameKey(event);
  if (key !== null) serviceManager.setEdited(event.sender.id, key, dirty === true);
});
ipcMain.on("guest:capture", (event, liveTracks) => {
  const key = guestFrameKey(event);
  if (key !== null) serviceManager.setCapture(event.sender.id, key, liveTracks);
});
ipcMain.on("guest:state", (event, payload) => {
  frameStateQuery.receive(guestFrameKey(event), payload);
});

const senderFrameUrl = (event) => {
  try {
    return event.senderFrame?.url ?? null;
  } catch {
    return null;
  }
};

const takeNotificationIntake = createRateLimiter(NOTIFICATION_INTAKE_LIMIT);
// The page's own toast is never shown: the preload replaced its Notification API, so this is the
// only path a web notification takes (D3). `captureWebNotifications` is retired and ignored.
ipcMain.on("guest:notification", (event, payload) => {
  // A popup notifies for the service that opened it.
  const service = serviceForContents(event.sender);
  const notification = sanitizeGuestNotification(payload);
  const frame = event.senderFrame;
  if (!service?.isEnabled || !notification || !frame) return;
  // Only the service's own frames may raise notifications; an ad or embed iframe cannot spoof one.
  // Ownership follows the service (its address, built-in aliases, where its home landed), never
  // the page the view or popup shows now, so a page that moved to another site cannot raise
  // toasts in the app's name. A popup is judged by the rules of the service that opened it.
  if (!isServiceOwnedUrl({ url: senderFrameUrl(event), serviceUrl: service.url, aliases: ownedAliasesFor(event.sender, service) })) return;
  if (!takeNotificationIntake(service.id)) return;
  deliverServiceNotification(service.id, {
    source: notification.kind === "worker" ? "worker-notification" : "web-notification",
    title: notification.title,
    body: notification.body,
    tag: notification.tag,
    silent: notification.silent,
    pageKey: `${event.sender.id}:${frameKeyOf(frame)}:${notification.id}`,
    // Worker notifications have no page object to click.
    target: notification.kind === "page" ? { frame, id: notification.id } : null
  });
});
ipcMain.on("guest:notification-close", (event, payload) => {
  if (!serviceForContents(event.sender) || typeof payload?.id !== "string") return;
  desktopNotifier.closeFromPage(`${event.sender.id}:${frameKeyOf(event.senderFrame)}:${payload.id}`);
});

shellIpc.handle("app-state:get", () => getAppState());

// Main owns new ids and every code-owned field; only user-editable fields are taken from the
// renderer. A new or changed address must be http(s); the rejection message is shown as is.
shellIpc.handle("services:save", (_event, payload) => {
  const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const existing = getAppState().services.find((service) => service.id === input.id) ?? null;
  let url = input.url;
  if (!existing || (typeof url === "string" && url !== existing.url)) {
    const checked = normalizeServiceUrl(url);
    if (!checked.ok) throw new Error(checked.error);
    url = checked.url;
  }
  const iconsDir = getIconsDirectory();
  const state = upsertService(sanitizeServiceInput({ ...input, url }, existing, {
    iconsDir,
    libraryIcons: iconLibrary.map((icon) => icon.iconSource),
    platform: pathPlatform
  }));
  // A replaced upload is deleted once no app shows it any more.
  const previousIcon = existing?.iconSource;
  if (previousIcon && state.services.find((service) => service.id === existing.id)?.iconSource !== previousIcon) {
    const unused = unusedIconFile(previousIcon, { services: state.services, iconsDir, platform: pathPlatform });
    if (unused) fs.promises.unlink(unused).catch(() => {});
  }
  broadcastState();
  return state;
});

// D7: resolves the new state, or null when the user cancels the confirm.
shellIpc.handle("services:remove", (event, serviceId) =>
  removeServiceWithConfirm(serviceId, BrowserWindow.fromWebContents(event.sender)));

shellIpc.handle("services:reorder", (_event, serviceIds) => {
  const state = reorderServices(serviceIds);
  broadcastState();
  return state;
});

shellIpc.handle("ui:set-active-service", (_event, serviceId) => selectService(serviceId));

shellIpc.handle("ui:set-notifications", (_event, enabled) => {
  const state = setUiState({ notificationsEnabled: Boolean(enabled) });
  broadcastState();
  return state;
});

shellIpc.handle("ui:set-memory-saver", (_event, enabled) => {
  const state = setUiState({ memorySaverEnabled: Boolean(enabled) });
  broadcastState();
  return state;
});

shellIpc.handle("ui:set-sidebar-collapsed", (_event, collapsed) => {
  const state = setUiState({ sidebarCollapsed: Boolean(collapsed) });
  broadcastState();
  return state;
});

// Registers or removes the OS login item. Only on change, so a login item the user disabled in
// Task Manager is never silently re-enabled at startup. Dev runs and Linux keep the setting only.
const applyLaunchAtLogin = (openAtLogin) => {
  const settings = loginItemSettingsFor({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    openAtLogin
  });
  if (!settings) return false;
  try {
    app.setLoginItemSettings(settings);
    return true;
  } catch (error) {
    writeStartupDiagnostic("Failed to update the launch-at-login setting.", error);
    return false;
  }
};

shellIpc.handle("ui:set-settings", (_event, partial) => {
  const before = getAppState().ui;
  const state = setAppSettings(partial);
  if (state.ui.launchAtLogin !== before.launchAtLogin) applyLaunchAtLogin(state.ui.launchAtLogin);
  broadcastState();
  return state;
});

shellIpc.handle("ui:set-window-mode", async (_event, mode) => {
  const nextMode = supportsDockMode() && mode === "dock" ? "dock" : "full";
  setUiState({ windowMode: nextMode });
  broadcastState();
  await syncWindowMode();
  return getAppState();
});

shellIpc.handle("ui:set-dock-corner", (_event, corner) => {
  const state = setUiState({ dockCorner: normalizeDockCorner(corner) });
  if (supportsDockMode()) {
    applyDockTriggerBounds();
    applyDockBounds();
    applyBubbleBounds();
    refreshDockTriggerCorner();
  }
  broadcastState();
  if (supportsDockMode()) {
    syncDockVisibility().catch(() => {});
  }
  return state;
});

shellIpc.handle("ui:set-dock-height", (_event, height) => {
  const state = setUiState({
    dockHeight: clampDockHeight(height)
  });

  if (supportsDockMode()) {
    applyDockTriggerBounds();
    applyDockBounds();
    applyBubbleBounds();
  }
  broadcastState();
  if (supportsDockMode()) {
    syncDockVisibility().catch(() => {});
  }
  return state;
});

shellIpc.handle("ui:set-dock-expanded", async (_event, expanded) => {
  if (!supportsDockMode()) {
    const state = setUiState({ windowMode: "full", dockExpanded: true });
    broadcastState();
    await syncWindowMode();
    return state;
  }
  const state = setUiState({ dockExpanded: Boolean(expanded) });
  if (state.ui.windowMode === "dock") {
    if (expanded) {
      if (!bubbleWindow || bubbleWindow.isDestroyed()) {
        await createBubbleWindow();
      } else {
        applyBubbleBounds();
      }
      await syncDockVisibility();
    } else {
      hideDockToTrigger();
    }
  }
  broadcastState();
  return getAppState();
});

shellIpc.handle("ui:open-dock-from-trigger", async () => {
  if (!supportsDockMode()) {
    return showFullApp();
  }
  cancelDockTeardown();
  setUiState({
    windowMode: "dock",
    dockExpanded: true
  });
  broadcastState();

  if (!dockTriggerWindow || dockTriggerWindow.isDestroyed()) {
    await createDockTriggerWindow();
  }
  await revealDockFromTrigger();
  return getAppState();
});

shellIpc.handle("ui:set-bubble-size", (_event, size) => {
  const state = setUiState({ bubbleSize: normalizePreferredBubbleSize(size) });
  if (supportsDockMode()) {
    applyBubbleBounds();
  }
  broadcastState();
  return state;
});

shellIpc.handle("webviews:refresh-active", () => requestActiveWebviewRefresh());

// Toolbar navigation for the selected service: back | forward | home | open-in-browser.
shellIpc.handle("services:navigate", async (_event, action) => {
  const activeId = getAppState().ui.activeServiceId;
  if (!activeId || !serviceManager) return false;
  if (action === "back") return serviceManager.goBack(activeId);
  if (action === "forward") return serviceManager.goForward(activeId);
  if (action === "home") return serviceManager.goHome(activeId);
  if (action === "open-in-browser") return openServiceInBrowser(activeId);
  return false;
});

// Find in the selected service. Resolves Electron's request id, or null when there is nothing to
// search; results arrive as `services:find-result`. An empty text ends the search.
shellIpc.handle("services:find", (event, text, options) => {
  const contents = serviceManager?.getContents() ?? null;
  const request = findTracker.request({
    contentsId: contents?.id ?? null,
    text,
    forward: options?.forward,
    findNext: options?.findNext,
    matchCase: options?.matchCase,
    replyTo: event.sender
  });
  if (!request) {
    stopFindIn(findTracker.stop());
    return null;
  }
  stopFindIn(request.previous);
  return contents.findInPage(request.text, request.options);
});
shellIpc.handle("services:stop-find", (event, action) => {
  stopFindIn(findTracker.stop(), normalizeStopFindAction(action));
  returnFocusAfterFind(event.sender);
  return true;
});

shellIpc.handle("services:context-menu", (event, serviceId) =>
  typeof serviceId === "string" ? showServiceContextMenu(serviceId, BrowserWindow.fromWebContents(event.sender)) : false);

// "Sleep now" (D16): any loaded app except the selected one. Resolves null when the user cancelled.
shellIpc.handle("services:sleep", (_event, serviceId) =>
  typeof serviceId === "string" ? sleepServiceAsking(serviceId) : false);

// Every OS process a page uses: its own renderer plus out-of-process (cross-site) frames.
const guestProcessIds = (contents) => {
  try {
    return [contents.getOSProcessId(), ...contents.mainFrame.framesInSubtree.map((frame) => frame.osProcessId)]
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
};

// Polled by the renderer while its memory panel is visible; never broadcast.
shellIpc.handle("services:get-metrics", () => {
  const servicePids = {};
  for (const [id, contents] of Object.entries(serviceManager?.getLiveContents() ?? {})) {
    servicePids[id] = guestProcessIds(contents);
  }
  return summarizeServiceMetrics({ metrics: app.getAppMetrics(), servicePids, sampledAt: Date.now() });
});

const applyOverlayBadge = () => {
  if (process.platform !== "win32" || !isLiveWindow(mainWindow)) return false;
  try {
    mainWindow.setOverlayIcon(overlayBadge?.image ?? null, overlayBadge?.description ?? "");
    return true;
  } catch (error) {
    writeStartupDiagnostic("Failed to set the taskbar badge.", error);
    return false;
  }
};

// The renderer draws the badge (a PNG data URL of at most 64 KB); null or a zero count clears it.
// Windows shows it on the main window's taskbar button; elsewhere the count goes to app.setBadgeCount.
shellIpc.handle("app:set-overlay-badge", (_event, payload) => {
  const badge = parseOverlayBadge(payload);
  if (!badge) return false;
  if (process.platform !== "win32") {
    try {
      return app.setBadgeCount(badge.count);
    } catch {
      return false;
    }
  }
  if (badge.dataUrl) {
    const image = nativeImage.createFromDataURL(badge.dataUrl);
    if (image.isEmpty()) return false;
    overlayBadge = { image, description: overlayDescription(badge.count) };
  } else {
    overlayBadge = null;
  }
  return applyOverlayBadge();
});

// Resolves the icon's file URL, null when cancelled; rejects with a readable reason for bad files.
shellIpc.handle("icons:upload", async (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? dockWindow ?? undefined;
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "Choose an app icon",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: [...ICON_UPLOAD_EXTENSIONS] }]
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return copyIconToUserData(result.filePaths[0]);
});

shellIpc.handle("updates:check", async () => {
  try {
    return await runUpdateCheck();
  } catch (error) {
    return {
      status: "error",
      currentVersion: app.getVersion(),
      platform: process.platform,
      error: error instanceof Error ? error.message : "Unknown update error"
    };
  }
});

// Opens only this repository's GitHub release pages, never another URL from the API response.
shellIpc.handle("updates:open", async () => {
  const updateInfo =
    lastUpdateCheck && Date.now() - lastUpdateCheck.at < updateCheckCacheMs ? lastUpdateCheck.info : await runUpdateCheck();
  const targetUrl = [updateInfo.assetUrl, updateInfo.releaseUrl].find((url) => isGitHubReleaseUrl(url, updatesRepository));

  if (!targetUrl) {
    return false;
  }

  return (await openExternalLink(targetUrl, { source: "updates" })) === "opened";
});

/** True while the user is looking at this service: selected, in a visible and focused host. */
const isViewingService = (serviceId, state = getAppState()) => {
  if (state.ui.activeServiceId !== serviceId) return false;
  if (state.ui.windowMode === "dock" && supportsDockMode() && !state.ui.dockExpanded) return false;
  const host = currentServiceHost(state);
  return isLiveWindow(host) && host.isVisible() && host.isFocused();
};

/** Sends a toast's click (or dismissal) back to the page's Notification object. */
const sendNotificationEvent = (target, type) => {
  try {
    if (target?.frame && !target.frame.isDestroyed() && !target.frame.detached) {
      target.frame.send("guest:notification-event", { id: target.id, type });
    }
  } catch (error) {
    writeStartupDiagnostic("Failed to forward a notification event to its page.", error);
  }
};

// A toast click selects its service, brings the app back in its current mode (full or dock) and
// lets the page open the conversation (D3).
/** The popup window a notification's frame lives in, or null for the service's own page. */
const popupWindowForFrame = (frame) => {
  try {
    if (!frame || frame.isDestroyed()) return null;
    const contents = webContents.fromFrame(frame);
    if (!contents || !popupOwners.has(contents.id)) return null;
    const popup = BrowserWindow.fromWebContents(contents);
    return popup && !popup.isDestroyed() ? popup : null;
  } catch {
    return null;
  }
};

const handleNotificationClick = async ({ serviceId, target }) => {
  const service = getAppState().services.find((item) => item.id === serviceId && item.isEnabled);
  if (service) {
    setUiState({ activeServiceId: service.id });
    markServiceSeen(service.id);
    broadcastState();
  }
  await revealApp();
  if (!service || !target) return;
  // A notification raised in a popup brings that popup forward as well.
  const popup = popupWindowForFrame(target.frame);
  if (popup) {
    if (popup.isMinimized()) popup.restore();
    popup.show();
    popup.focus();
  }
  sendNotificationEvent(target, "click");
};

const desktopNotifier = createDesktopNotifier({
  createToast: (options) => new Notification(options),
  isSupported: () => Notification.isSupported(),
  onClick: (click) => {
    handleNotificationClick(click).catch((error) => writeStartupDiagnostic("Failed to open a notification.", error));
  },
  onPageClose: (target) => sendNotificationEvent(target, "close"),
  log: writeStartupDiagnostic
});

// History is memory-only (D6); renderers see it as runtime.unseenNotificationCounts. A
// notification for the service the user is looking at is not "unseen".
const deliverServiceNotification = (serviceId, payload = {}) => {
  const state = getAppState();
  const service = state.services.find((item) => item.id === serviceId && item.isEnabled);
  if (!service) return false;
  const source = payload.source || "activity";
  const title = String(payload.title || service.name).slice(0, 300);
  const fallbackBody = source === "web-notification" || source === "worker-notification" ? "" : "New activity detected";
  const body = String(payload.message || payload.body || fallbackBody).slice(0, 1000);
  if (!isViewingService(service.id, state)) {
    notificationHistory.record({ serviceId, serviceName: service.name, source, title, body });
    broadcastRuntime();
  }
  if (!shouldShowDesktopToast({ ui: state.ui, service })) return false;
  return desktopNotifier.notify({
    serviceId: service.id,
    serviceName: service.name,
    title,
    body,
    tag: payload.tag ?? "",
    silent: payload.silent === true,
    pageKey: payload.pageKey ?? null,
    target: payload.target ?? null
  }) === "shown";
};
shellIpc.handle("notifications:service-event", (_event, payload) => {
  return deliverServiceNotification(payload?.serviceId, {
    source: "test",
    title: payload?.title,
    body: payload?.body,
    message: payload?.message
  });
});

shellIpc.handle("notifications:clear-history", () => {
  if (notificationHistory.clear()) broadcastRuntime();
  return getAppState();
});

shellIpc.handle("notifications:mark-seen", (_event, serviceId) => {
  markServiceSeen(serviceId);
  return getAppState();
});

// The in-app picker's answer (D9): { requestId, sourceId (null = cancel), shareAudio }.
shellIpc.handle("screen-share:respond", (event, response) => screenShareBroker.respond(event.sender.id, response));
// The preload reports when its renderer subscribes or unsubscribes an in-app picker.
shellIpc.on("screen-share:picker", (event, active) => setScreenSharePicker(event.sender.id, active === true));

// Tells the user once why their apps are missing when the settings file had to be bypassed.
const notifyConfigLoadIssue = () => {
  const issue = getConfigLoadIssue();
  if (!issue || !Notification.isSupported()) return;
  new Notification(issue.status === "corrupt"
    ? {
        title: "Comms Hub settings were reset",
        body: "The settings file was damaged, so defaults are in use. The old file was kept next to the new one."
      }
    : {
        title: "Comms Hub could not load its settings",
        body: "Defaults are in use for this session and changes will not be saved. Restart Comms Hub to try again."
      }).show();
};

const wasOpenedAtLogin = () => {
  if (process.platform !== "darwin") return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
};

// Login-item launches and "start minimized" start in the tray; in dock mode that is the
// collapsed dock (just the trigger), which is how dock mode is "minimized".
const applyHiddenStart = () => {
  const { ui } = getAppState();
  startHidden = shouldStartHidden({
    argv: process.argv,
    startMinimized: ui.startMinimized,
    wasOpenedAtLogin: wasOpenedAtLogin()
  });
  if (startHidden && ui.windowMode === "dock" && supportsDockMode()) {
    setUiState({ dockExpanded: false });
  }
};

process.on("uncaughtException", (error) => {
  writeStartupDiagnostic("Uncaught exception during Comms Hub startup/runtime.", error);
});

process.on("unhandledRejection", (reason) => {
  writeStartupDiagnostic("Unhandled rejection during Comms Hub startup/runtime.", reason);
});

const startPrimaryInstance = () => {
  // Backstop: no page may attach a <webview> (webviewTag is off everywhere).
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  // A second launch (Start menu, desktop shortcut) exits at once and lands here instead (D22).
  app.on("second-instance", () => {
    app
      .whenReady()
      .then(revealApp)
      .catch((error) => writeStartupDiagnostic("Failed to reveal Comms Hub for a second launch.", error));
  });

  app.whenReady().then(() => {
    // D12: drops Electron's default menu and its accelerators before any window exists.
    const menuTemplate = applicationMenuTemplate(process.platform);
    Menu.setApplicationMenu(menuTemplate ? Menu.buildFromTemplate(menuTemplate) : null);
    // D15: every page without its own override (popups and workers included) gets the clean UA.
    app.userAgentFallback = getGuestUserAgent();
    initializeServiceManager();
    watchPowerEvents();
    notifyConfigLoadIssue();
    configureKnownSessions();
    normalizeUnsupportedDockMode();
    applyHiddenStart();
    broadcastState();
    ensureTray();
    setInterval(() => {
      flushKnownSessions().catch(() => {});
    }, sessionFlushIntervalMs);
    screen.on("display-metrics-changed", () => {
      if (supportsDockMode()) {
        restoreDockWindows();
      }
    });
    screen.on("display-added", () => {
      if (supportsDockMode()) {
        restoreDockWindows();
      }
    });
    screen.on("display-removed", () => {
      if (supportsDockMode()) {
        restoreDockWindows();
      }
    });
    syncWindowMode()
      .then(() => {
        startHidden = false;
      })
      .catch((error) => {
        writeStartupDiagnostic("Failed to create main window.", error);
        app.quit();
      });
  });

  app.on("before-quit", (event) => {
    if (shutdownInProgress) {
      return;
    }

    event.preventDefault();
    shutdownInProgress = true;
    saveMainWindowState();
    // app.exit() below skips will-quit, so debounced settings are written here, synchronously.
    flushPendingWrites();
    trayController.destroy();
    flushKnownSessions()
      .catch(() => {})
      .finally(() => {
        destroyAllWindows();
        flushPendingWrites();
        app.exit();
      });
  });

  // Last resort for exits that bypass before-quit (e.g. app.exit() from elsewhere).
  process.on("exit", () => {
    flushPendingWrites();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    ensureTray();
    if (supportsDockMode()) {
      restoreDockWindows();
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      syncWindowMode().catch((error) => {
        console.error("Failed to recreate main window.", error);
      });
    }
  });
};

if (hasInstanceLock) {
  startPrimaryInstance();
} else {
  // Another copy owns this profile and has been told to show itself; leave without touching it.
  app.exit(0);
}
