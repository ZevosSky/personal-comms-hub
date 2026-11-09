import assert from "node:assert/strict";
import test from "node:test";
import { buildGuestContextMenu, buildServiceRailMenu, buildShellContextMenu, tidyMenu } from "../electron/contextMenu.js";

const labels = (items) => items.filter((item) => item.type !== "separator").map((item) => item.label);
const byLabel = (items, label) => items.find((item) => item.label === label);
const allFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const params = (overrides = {}) => ({
  x: 10, y: 20, isEditable: false, misspelledWord: "", dictionarySuggestions: [], selectionText: "", linkURL: "",
  mediaType: "none", srcURL: "", hasImageContents: false, editFlags: {}, ...overrides
});
const noBadSeparators = (items) => {
  assert.notEqual(items[0]?.type, "separator");
  assert.notEqual(items.at(-1)?.type, "separator");
  items.forEach((item, index) => assert.ok(!(item.type === "separator" && items[index + 1]?.type === "separator")));
};

test("an editable field with a misspelling offers suggestions, the dictionary and editing", () => {
  const items = buildGuestContextMenu(params({
    isEditable: true, misspelledWord: "helo", dictionarySuggestions: ["hello", "help", "hell", "held", "helm", "helot"],
    editFlags: { ...allFlags, canUndo: false }
  }));
  assert.deepEqual(labels(items), [
    "hello", "help", "hell", "held", "helm", "Add to dictionary",
    "Undo", "Redo", "Cut", "Copy", "Paste", "Paste as plain text", "Select all", "Inspect"
  ]);
  assert.deepEqual(byLabel(items, "hello"), { id: "replace-misspelling", label: "hello", args: "hello" });
  assert.equal(byLabel(items, "Add to dictionary").args, "helo");
  assert.equal(byLabel(items, "Undo").enabled, false);
  assert.equal(byLabel(items, "Paste").enabled, true);
  assert.equal(byLabel(items, "Back"), undefined, "no navigation while editing");
  noBadSeparators(items);
});

test("a misspelling without suggestions says so; edit flags gate the items", () => {
  const items = buildGuestContextMenu(params({ isEditable: true, misspelledWord: "qzx", editFlags: { canPaste: false, canCut: false } }));
  assert.equal(byLabel(items, "No spelling suggestions").enabled, false);
  assert.equal(byLabel(items, "Cut").enabled, false);
  assert.equal(byLabel(items, "Paste as plain text").enabled, false);
});

test("selected text, links, email links and images", () => {
  assert.deepEqual(labels(buildGuestContextMenu(params({ selectionText: "hello" }))), ["Copy", "Inspect"]);
  const link = buildGuestContextMenu(params({ linkURL: "https://example.com/a" }));
  assert.deepEqual(labels(link), ["Open link in browser", "Copy link address", "Inspect"]);
  assert.deepEqual(byLabel(link, "Open link in browser"), { id: "open-link", label: "Open link in browser", args: "https://example.com/a" });
  assert.equal(byLabel(link, "Copy link address").args, "https://example.com/a");
  const mail = buildGuestContextMenu(params({ linkURL: "mailto:first%20last@example.com?subject=Hi" }));
  assert.equal(byLabel(mail, "Copy email address").args, "first last@example.com");
  const image = buildGuestContextMenu(params({ mediaType: "image", srcURL: "https://cdn.example/x.png", hasImageContents: true, linkURL: "https://example.com/p" }));
  assert.deepEqual(labels(image), ["Open link in browser", "Copy link address", "Copy image", "Save image", "Inspect"]);
  assert.deepEqual(byLabel(image, "Copy image").args, { x: 10, y: 20 });
  assert.equal(byLabel(image, "Save image").args, "https://cdn.example/x.png");
  assert.equal(byLabel(buildGuestContextMenu(params({ mediaType: "image", srcURL: "blob:x", hasImageContents: false })), "Copy image").enabled, false);
});

test("the plain page offers back, forward, reload and open in browser; Inspect is always last", () => {
  const items = buildGuestContextMenu(params(), { canGoBack: true, canGoForward: false });
  assert.deepEqual(labels(items), ["Back", "Forward", "Reload", "Open page in browser", "Inspect"]);
  assert.equal(byLabel(items, "Back").enabled, true);
  assert.equal(byLabel(items, "Forward").enabled, false);
  assert.deepEqual(byLabel(items, "Inspect").args, { x: 10, y: 20 });
  noBadSeparators(items);
  assert.deepEqual(labels(buildGuestContextMenu(params({ mediaType: "video", srcURL: "https://v.example/v.mp4" }))), ["Inspect"]);
});

test("the shell menu only edits its own inputs", () => {
  assert.deepEqual(buildShellContextMenu(params()), []);
  assert.deepEqual(labels(buildShellContextMenu(params({ selectionText: "x" }))), ["Copy"]);
  const editable = buildShellContextMenu(params({ isEditable: true, editFlags: allFlags }));
  assert.deepEqual(labels(editable), ["Undo", "Redo", "Cut", "Copy", "Paste", "Paste as plain text", "Select all"]);
  assert.equal(byLabel(editable, "Inspect"), undefined);
});

test("the rail menu reflects the app and its runtime", () => {
  const custom = {
    id: "c", isBuiltIn: false, isEnabled: true, keepAliveInBackground: true,
    notificationSettings: { desktopEnabled: false }
  };
  const loaded = { status: "idle", webContentsId: 12 };
  const items = buildServiceRailMenu({ service: custom, runtime: loaded, isActive: false });
  assert.deepEqual(labels(items), ["Reload", "Sleep now", "Keep alive", "Desktop alerts", "Edit…", "Open in browser", "Remove…"]);
  assert.equal(byLabel(items, "Sleep now").enabled, true);
  assert.equal(byLabel(items, "Keep alive").checked, true);
  assert.equal(byLabel(items, "Keep alive").type, "checkbox");
  assert.equal(byLabel(items, "Desktop alerts").checked, false);
  noBadSeparators(items);

  const active = buildServiceRailMenu({ service: custom, runtime: loaded, isActive: true });
  assert.equal(byLabel(active, "Sleep now").enabled, false, "the selected app is never put to sleep");
  const asleep = buildServiceRailMenu({ service: custom, runtime: { status: "sleeping", webContentsId: null } });
  assert.equal(byLabel(asleep, "Sleep now").enabled, false);
  assert.equal(byLabel(asleep, "Reload").enabled, false);
  const builtIn = buildServiceRailMenu({ service: { ...custom, isBuiltIn: true, notificationSettings: undefined } });
  assert.equal(labels(builtIn).at(-1), "Hide on this device");
  assert.equal(byLabel(builtIn, "Desktop alerts").checked, true, "alerts default to on");

  const remembered = buildServiceRailMenu({ service: custom, runtime: loaded, hasPermissionDecisions: true });
  assert.deepEqual(labels(remembered), [
    "Reload", "Sleep now", "Keep alive", "Desktop alerts", "Edit…", "Open in browser", "Reset site permissions", "Remove…"
  ]);
  assert.equal(byLabel(remembered, "Reset site permissions").id, "reset-permissions");
  noBadSeparators(remembered);
});

test("tidyMenu drops stray separators", () => {
  const separator = { type: "separator" };
  assert.deepEqual(tidyMenu([separator, { id: "a" }, separator, separator, { id: "b" }, separator]), [{ id: "a" }, separator, { id: "b" }]);
  assert.deepEqual(tidyMenu([separator]), []);
});
