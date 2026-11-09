import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationMenuTemplate,
  cycleServiceId,
  resolveAppCommand,
  resolveShortcut,
  serviceIdAtIndex,
  stepZoomFactor
} from "../electron/shortcuts.js";

const key = (keyName, { code = "", control = false, shift = false, alt = false, meta = false, repeat = false, type = "keyDown", composing = false } = {}) => ({
  type, key: keyName, code, control, shift, alt, meta, isAutoRepeat: repeat, isComposing: composing
});
const win = (input) => resolveShortcut(input, { platform: "win32" });
const mac = (input) => resolveShortcut(input, { platform: "darwin" });

test("Ctrl+1..9 select the nth visible app, including layouts where the digit keys type symbols", () => {
  for (let digit = 1; digit <= 9; digit += 1) {
    assert.deepEqual(win(key(String(digit), { code: `Digit${digit}`, control: true })), { action: "select", index: digit - 1 });
  }
  assert.deepEqual(win(key("&", { code: "Digit1", control: true })), { action: "select", index: 0 }, "AZERTY");
  assert.deepEqual(win(key("3", { code: "Numpad3", control: true })), { action: "select", index: 2 }, "numpad with Num Lock on");
  assert.equal(win(key("End", { code: "Numpad1", control: true })), null, "Ctrl+End on the numpad stays with the page");
  assert.equal(win(key("1", { code: "Digit1", control: true, alt: true })), null, "AltGr (Ctrl+Alt) combinations type characters");
  assert.equal(win(key("1", { code: "Digit1" })), null);
});

test("switching, reloading, zoom, find, navigation, DevTools and settings follow D11", () => {
  assert.deepEqual(win(key("Tab", { control: true })), { action: "cycle", direction: 1 });
  assert.deepEqual(win(key("Tab", { control: true, shift: true })), { action: "cycle", direction: -1 });
  assert.deepEqual(win(key("PageDown", { control: true })), { action: "cycle", direction: 1 });
  assert.deepEqual(win(key("PageUp", { control: true })), { action: "cycle", direction: -1 });
  assert.deepEqual(win(key("r", { code: "KeyR", control: true })), { action: "reload", ignoreCache: false });
  assert.deepEqual(win(key("R", { code: "KeyR", control: true, shift: true })), { action: "reload", ignoreCache: true });
  assert.deepEqual(win(key("к", { code: "KeyR", control: true })), { action: "reload", ignoreCache: false }, "non-Latin layouts use the key position");
  assert.deepEqual(win(key("F5")), { action: "reload", ignoreCache: false });
  assert.deepEqual(win(key("F5", { shift: true })), { action: "reload", ignoreCache: true });
  assert.deepEqual(win(key("F5", { control: true })), { action: "reload", ignoreCache: true });
  assert.deepEqual(win(key("=", { code: "Equal", control: true })), { action: "zoom", direction: 1 });
  assert.deepEqual(win(key("+", { code: "Equal", control: true, shift: true })), { action: "zoom", direction: 1 });
  assert.deepEqual(win(key("+", { code: "NumpadAdd", control: true })), { action: "zoom", direction: 1 });
  assert.deepEqual(win(key("-", { code: "Minus", control: true })), { action: "zoom", direction: -1 });
  assert.deepEqual(win(key("0", { code: "Digit0", control: true })), { action: "zoom", direction: 0 });
  assert.deepEqual(win(key("f", { code: "KeyF", control: true })), { action: "find" });
  assert.deepEqual(win(key("ArrowLeft", { alt: true })), { action: "back" });
  assert.deepEqual(win(key("ArrowRight", { alt: true })), { action: "forward" });
  assert.deepEqual(win(key("I", { code: "KeyI", control: true, shift: true })), { action: "devtools" });
  assert.deepEqual(win(key("F12")), { action: "devtools" });
  assert.deepEqual(win(key(",", { code: "Comma", control: true })), { action: "settings" });
});

test("Ctrl+W, plain typing and other keys stay with the page", () => {
  assert.equal(win(key("w", { code: "KeyW", control: true })), null, "Ctrl+W never closes or quits anything");
  assert.equal(win(key("W", { code: "KeyW", control: true, shift: true })), null);
  assert.equal(win(key("q", { code: "KeyQ", control: true })), null);
  assert.equal(win(key("c", { code: "KeyC", control: true })), null, "copy/paste are the page's");
  assert.equal(win(key("r", { code: "KeyR" })), null);
  assert.equal(win(key("ArrowLeft")), null);
  assert.equal(win(key("ArrowLeft", { alt: true, shift: true })), null);
  assert.equal(win(key("Tab")), null);
  assert.equal(win(key("r", { code: "KeyR", control: true, type: "keyUp" })), null);
  assert.equal(win(key("r", { code: "KeyR", control: true, composing: true })), null, "IME composition");
  assert.equal(win(null), null);
});

test("held keys repeat only for zoom, switching and navigation", () => {
  assert.equal(win(key("r", { code: "KeyR", control: true, repeat: true })), null);
  assert.equal(win(key("F12", { repeat: true })), null);
  assert.equal(win(key("1", { code: "Digit1", control: true, repeat: true })), null);
  assert.deepEqual(win(key("=", { code: "Equal", control: true, repeat: true })), { action: "zoom", direction: 1 });
  assert.deepEqual(win(key("Tab", { control: true, repeat: true })), { action: "cycle", direction: 1 });
  assert.deepEqual(win(key("ArrowLeft", { alt: true, repeat: true })), { action: "back" });
});

test("macOS uses Command, and leaves Option+arrows to text editing", () => {
  assert.deepEqual(mac(key("1", { code: "Digit1", meta: true })), { action: "select", index: 0 });
  assert.equal(mac(key("1", { code: "Digit1", control: true })), null);
  assert.deepEqual(mac(key("r", { code: "KeyR", meta: true })), { action: "reload", ignoreCache: false });
  assert.deepEqual(mac(key("[", { code: "BracketLeft", meta: true })), { action: "back" });
  assert.deepEqual(mac(key("]", { code: "BracketRight", meta: true })), { action: "forward" });
  assert.equal(mac(key("ArrowLeft", { alt: true })), null);
  assert.deepEqual(mac(key("ˆ", { code: "KeyI", meta: true, alt: true })), { action: "devtools" });
  assert.deepEqual(mac(key("Tab", { control: true })), { action: "cycle", direction: 1 });
  assert.deepEqual(mac(key(",", { code: "Comma", meta: true })), { action: "settings" });
  assert.equal(mac(key("w", { code: "KeyW", meta: true })), null);
});

test("mouse back/forward buttons", () => {
  assert.equal(resolveAppCommand("browser-backward"), "back");
  assert.equal(resolveAppCommand("browser-forward"), "forward");
  assert.equal(resolveAppCommand("media-play-pause"), null);
});

test("no default menu on Windows/Linux; macOS gets only the app and edit menus (D12)", () => {
  assert.equal(applicationMenuTemplate("win32"), null);
  assert.equal(applicationMenuTemplate("linux"), null);
  const macMenu = applicationMenuTemplate("darwin");
  assert.deepEqual(macMenu, [{ role: "appMenu" }, { role: "editMenu" }]);
  assert.ok(!JSON.stringify(macMenu).includes('"close"') && !JSON.stringify(macMenu).includes("+W"));
});

test("zoom steps on the 10% grid and stays within the limits", () => {
  assert.equal(stepZoomFactor(1, 1), 1.1);
  assert.equal(stepZoomFactor(1, -1), 0.9);
  assert.equal(stepZoomFactor(0.8, 1), 0.9);
  assert.equal(stepZoomFactor(1.1, -1), 1);
  assert.equal(stepZoomFactor(0.83, 1), 0.9, "off-grid values snap to the grid");
  assert.equal(stepZoomFactor(2, 1), 2);
  assert.equal(stepZoomFactor(0.5, -1), 0.5);
  assert.equal(stepZoomFactor(1.7, 0), 1);
  assert.equal(stepZoomFactor(undefined, 1), 1.1);
});

test("app selection counts only visible apps and wraps", () => {
  const services = [
    { id: "a", isEnabled: true },
    { id: "hidden", isEnabled: false },
    { id: "b", isEnabled: true },
    { id: "c", isEnabled: true }
  ];
  assert.equal(serviceIdAtIndex(services, 0), "a");
  assert.equal(serviceIdAtIndex(services, 1), "b", "hidden apps are skipped");
  assert.equal(serviceIdAtIndex(services, 5), null);
  assert.equal(cycleServiceId(services, "a", 1), "b");
  assert.equal(cycleServiceId(services, "c", 1), "a");
  assert.equal(cycleServiceId(services, "a", -1), "c");
  assert.equal(cycleServiceId(services, "hidden", 1), "a");
  assert.equal(cycleServiceId(services, null, -1), "c");
  assert.equal(cycleServiceId([], "a", 1), null);
});
