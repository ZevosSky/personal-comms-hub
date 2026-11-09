// In-memory config store with debounced persistence. Electron-free so it can be unit-tested;
// electron/configStore.js binds it to the real settings file.
import { randomUUID } from "node:crypto";
import { getDockModeCapabilities, normalizeWindowState } from "./windowGeometry.js";
import {
  PERMISSION_DECISIONS,
  buildAppState,
  deepFreeze,
  isPlainObject,
  isValidPermissionName,
  migrateConfig,
  normalizePermissionOrigin,
  normalizeService,
  normalizeUi,
  sanitizeAppSettings,
  toPersistedConfig,
  uiEquals
} from "./appStateModel.js";

const maxOriginsPerService = 100;
const maxRetryDelayMs = 60000;

/**
 * The file is read once, on first use. Every mutation replaces the in-memory config, drops the
 * memoized snapshot and schedules one write; getAppState() returns the same frozen snapshot until
 * something changes, so hot paths never touch the disk.
 */
export function createConfigStore({
  backing,
  platform = process.platform,
  persistDelayMs = 250,
  retryDelayMs = 2000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = () => {},
  createId = randomUUID
}) {
  const capabilities = getDockModeCapabilities(platform);
  let config = null;
  let snapshot = null;
  let dirty = false;
  let timer = null;
  let canPersist = true;
  let failedWrites = 0;
  let loadIssue = null;

  const arm = (delay) => {
    timer = setTimeoutFn(() => {
      timer = null;
      flush();
    }, delay);
  };

  const flush = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (!dirty || !config || !canPersist) return true;
    try {
      backing.save(toPersistedConfig(config));
      dirty = false;
      if (failedWrites) log("Comms Hub settings saved after earlier failures.");
      failedWrites = 0;
      return true;
    } catch (error) {
      if (!failedWrites) log("Failed to save Comms Hub settings; retrying in the background.", error);
      arm(Math.min(maxRetryDelayMs, retryDelayMs * 2 ** failedWrites));
      failedWrites += 1;
      return false;
    }
  };

  const schedulePersist = () => {
    if (!canPersist) return;
    dirty = true;
    if (timer === null) arm(persistDelayMs);
  };

  const load = () => {
    if (config) return config;
    const result = backing.load();
    if (result.status === "corrupt" || result.status === "unreadable") {
      loadIssue = Object.freeze({ status: result.status, backupPath: result.backupPath ?? null });
    }
    if (result.status === "corrupt") {
      log(`Comms Hub settings were invalid and have been reset to defaults. The old file was kept as ${result.backupPath}.`, result.error);
    } else if (result.status === "unreadable") {
      canPersist = false;
      log("Comms Hub could not read its settings file. Using defaults without saving this session.", result.error);
    }
    const migrated = migrateConfig(result.data);
    config = { ...migrated.config, permissionDecisions: deepFreeze(migrated.config.permissionDecisions) };
    if (migrated.changed || result.status === "corrupt") schedulePersist();
    return config;
  };

  const getAppState = () => {
    snapshot ??= buildAppState(load(), capabilities);
    return snapshot;
  };

  const commit = (next) => {
    config = next;
    snapshot = null;
    schedulePersist();
    return getAppState();
  };

  const commitServices = (current, services, activeServiceId = current.ui.activeServiceId) =>
    commit({ ...current, services, ui: normalizeUi({ ...current.ui, activeServiceId }, services) });

  const setUiState = (updates) => {
    const current = load();
    const ui = normalizeUi({ ...current.ui, ...(isPlainObject(updates) ? updates : {}) }, current.services);
    return uiEquals(ui, current.ui) ? getAppState() : commit({ ...current, ui });
  };

  const upsertService = (partial) => {
    const current = load();
    const source = isPlainObject(partial) ? partial : {};
    const existing = current.services.find((service) => service.id === source.id) ?? null;
    const requestedId = typeof source.id === "string" ? source.id.trim() : "";
    const id = existing?.id ?? (requestedId || createId());
    const next = normalizeService({ ...source, id }, existing);
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return getAppState();

    const services = existing
      ? current.services.map((service) => (service.id === id ? next : service))
      : [...current.services, next];
    const activeServiceId =
      !next.isEnabled && current.ui.activeServiceId === id
        ? services.find((service) => service.id !== id && service.isEnabled)?.id ?? null
        : !existing && next.isEnabled
          ? id
          : current.ui.activeServiceId;
    return commitServices(current, services, activeServiceId);
  };

  const removeService = (serviceId) => {
    const current = load();
    const target = current.services.find((service) => service.id === serviceId);
    if (!target || target.isBuiltIn) return getAppState();

    const services = current.services.filter((service) => service.id !== serviceId);
    const { [serviceId]: _removed, ...permissionDecisions } = current.permissionDecisions;
    return commitServices({ ...current, permissionDecisions: deepFreeze(permissionDecisions) }, services);
  };

  const reorderServices = (serviceIds) => {
    const current = load();
    const ids = Array.isArray(serviceIds) ? serviceIds.filter((id) => typeof id === "string") : [];
    const byId = new Map(current.services.map((service) => [service.id, service]));
    const ordered = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
    const remaining = current.services.filter((service) => !ordered.includes(service));
    const services = [...ordered, ...remaining];
    if (services.every((service, index) => service === current.services[index])) return getAppState();
    return commitServices(current, services);
  };

  const getPermissionDecision = (serviceId, origin, permission) =>
    load().permissionDecisions[serviceId]?.[normalizePermissionOrigin(origin)]?.[permission] ?? null;

  /** decision: "allow" | "block", or null to forget. Not part of the renderer snapshot. */
  const setPermissionDecision = (serviceId, origin, permission, decision) => {
    const current = load();
    const key = normalizePermissionOrigin(origin);
    if (
      !key ||
      !isValidPermissionName(permission) ||
      (decision !== null && !PERMISSION_DECISIONS.includes(decision)) ||
      !current.services.some((service) => service.id === serviceId)
    ) {
      return false;
    }

    const byOrigin = { ...(current.permissionDecisions[serviceId] ?? {}) };
    const decisions = { ...(byOrigin[key] ?? {}) };
    if (decision === null) delete decisions[permission];
    else decisions[permission] = decision;
    delete byOrigin[key];
    if (Object.keys(decisions).length) byOrigin[key] = decisions;
    const origins = Object.keys(byOrigin);
    for (const stale of origins.slice(0, Math.max(0, origins.length - maxOriginsPerService))) delete byOrigin[stale];

    const permissionDecisions = { ...current.permissionDecisions, [serviceId]: byOrigin };
    if (!Object.keys(byOrigin).length) delete permissionDecisions[serviceId];
    // Decisions are not in the snapshot, so it stays valid.
    config = { ...current, permissionDecisions: deepFreeze(permissionDecisions) };
    schedulePersist();
    return true;
  };

  const getMainWindowState = () => load().mainWindowState ?? null;

  /** Saves the main window's placement; returns false when it is invalid or unchanged. */
  const setMainWindowState = (raw) => {
    const current = load();
    const next = normalizeWindowState(raw);
    if (!next || JSON.stringify(next) === JSON.stringify(current.mainWindowState ?? null)) return false;
    // Not in the snapshot, so it stays valid and renderers are not re-sent state.
    config = { ...current, mainWindowState: Object.freeze(next) };
    schedulePersist();
    return true;
  };

  const clearPermissionDecisions = (serviceId) => {
    const current = load();
    if (!current.permissionDecisions[serviceId]) return false;
    const { [serviceId]: _removed, ...permissionDecisions } = current.permissionDecisions;
    config = { ...current, permissionDecisions: deepFreeze(permissionDecisions) };
    schedulePersist();
    return true;
  };

  return {
    getAppState,
    setUiState,
    setAppSettings: (partial) => setUiState(sanitizeAppSettings(partial)),
    upsertService,
    removeService,
    reorderServices,
    getPermissionDecision,
    setPermissionDecision,
    clearPermissionDecisions,
    /** True when the service has any remembered allow or block. */
    hasPermissionDecisions: (serviceId) => Boolean(load().permissionDecisions[serviceId]),
    getMainWindowState,
    setMainWindowState,
    flush,
    hasPendingWrites: () => dirty,
    /** null, or { status: "corrupt" | "unreadable", backupPath } when defaults had to be used. */
    getLoadIssue: () => {
      load();
      return loadIssue;
    }
  };
}
