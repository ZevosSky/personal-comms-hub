// Native context menus as plain descriptors. Electron-free: main turns each descriptor into a
// MenuItem whose click runs `actions[id](args)`.
// Descriptor: { id, label, enabled?, args?, type?: "separator" | "checkbox", checked? }.

const separator = Object.freeze({ type: "separator" });
const maxSuggestions = 5;

/** Drops leading, trailing and doubled separators. */
export const tidyMenu = (items) => {
  const result = [];
  for (const item of items) {
    if (item.type === "separator" && (!result.length || result.at(-1).type === "separator")) continue;
    result.push(item);
  }
  while (result.at(-1)?.type === "separator") result.pop();
  return result;
};

const spellingItems = (params) => {
  if (!params.isEditable || !params.misspelledWord) return [];
  const suggestions = (params.dictionarySuggestions ?? []).slice(0, maxSuggestions);
  return [
    ...(suggestions.length
      ? suggestions.map((word) => ({ id: "replace-misspelling", label: word, args: word }))
      : [{ id: "no-suggestions", label: "No spelling suggestions", enabled: false }]),
    { id: "add-to-dictionary", label: "Add to dictionary", args: params.misspelledWord },
    separator
  ];
};

const editItems = (params) => {
  const flags = params.editFlags ?? {};
  if (params.isEditable) {
    return [
      { id: "undo", label: "Undo", enabled: flags.canUndo !== false },
      { id: "redo", label: "Redo", enabled: flags.canRedo !== false },
      separator,
      { id: "cut", label: "Cut", enabled: flags.canCut !== false },
      { id: "copy", label: "Copy", enabled: flags.canCopy !== false },
      { id: "paste", label: "Paste", enabled: flags.canPaste !== false },
      { id: "paste-plain", label: "Paste as plain text", enabled: flags.canPaste !== false },
      { id: "select-all", label: "Select all", enabled: flags.canSelectAll !== false },
      separator
    ];
  }
  return params.selectionText?.trim() ? [{ id: "copy", label: "Copy" }, separator] : [];
};

const linkItems = (params) => {
  const link = typeof params.linkURL === "string" ? params.linkURL : "";
  if (!link) return [];
  const mail = /^mailto:/i.test(link);
  return [
    { id: "open-link", label: "Open link in browser", args: link },
    mail
      ? { id: "copy-text", label: "Copy email address", args: decodeMailAddress(link) }
      : { id: "copy-text", label: "Copy link address", args: link },
    separator
  ];
};

const decodeMailAddress = (link) => {
  const address = link.replace(/^mailto:/i, "").split("?")[0];
  try {
    return decodeURIComponent(address);
  } catch {
    return address;
  }
};

const imageItems = (params) => {
  if (params.mediaType !== "image" || !params.srcURL) return [];
  return [
    { id: "copy-image", label: "Copy image", args: { x: params.x, y: params.y }, enabled: params.hasImageContents !== false },
    { id: "save-image", label: "Save image", args: params.srcURL },
    separator
  ];
};

/**
 * The right-click menu for a service page. `navigation` is { canGoBack, canGoForward }. Back,
 * forward and reload appear only on the plain page, as in a browser; Inspect is always last.
 */
export const buildGuestContextMenu = (params = {}, navigation = {}) => {
  const contextual = [...spellingItems(params), ...editItems(params), ...linkItems(params), ...imageItems(params)];
  const plainPage = !contextual.length && params.mediaType !== "video" && params.mediaType !== "audio";
  const page = plainPage
    ? [
        { id: "back", label: "Back", enabled: navigation.canGoBack === true },
        { id: "forward", label: "Forward", enabled: navigation.canGoForward === true },
        { id: "reload", label: "Reload" },
        separator,
        { id: "open-page", label: "Open page in browser" },
        separator
      ]
    : [];
  return tidyMenu([...contextual, ...page, { id: "inspect", label: "Inspect", args: { x: params.x, y: params.y } }]);
};

/** The shell's own menu: editing for its inputs (the add/edit form), copy for selected text. */
export const buildShellContextMenu = (params = {}) =>
  tidyMenu([...spellingItems(params), ...editItems(params)]);

/**
 * The rail's per-app menu (`services:context-menu`). `runtime` is that app's runtime entry;
 * `isActive` whether it is the selected app; `hasPermissionDecisions` whether it has remembered
 * camera, microphone or screen answers (only then is "Reset site permissions" shown).
 */
export const buildServiceRailMenu = ({ service, runtime = null, isActive = false, hasPermissionDecisions = false }) => {
  const loaded = Boolean(runtime?.webContentsId) && runtime?.status !== "closing";
  return tidyMenu([
    { id: "reload", label: "Reload", enabled: service.isEnabled && (isActive || loaded) },
    { id: "sleep", label: "Sleep now", enabled: loaded && !isActive },
    separator,
    { id: "keep-alive", label: "Keep alive", type: "checkbox", checked: service.keepAliveInBackground === true },
    {
      id: "desktop-alerts",
      label: "Desktop alerts",
      type: "checkbox",
      checked: service.notificationSettings?.desktopEnabled !== false
    },
    separator,
    { id: "edit", label: "Edit…" },
    { id: "open-in-browser", label: "Open in browser" },
    ...(hasPermissionDecisions ? [{ id: "reset-permissions", label: "Reset site permissions" }] : []),
    separator,
    service.isBuiltIn ? { id: "hide", label: "Hide on this device" } : { id: "remove", label: "Remove…" }
  ]);
};
