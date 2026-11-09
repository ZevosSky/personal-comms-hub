import assert from "node:assert/strict";
import test from "node:test";
import { normalizeService } from "../electron/appStateModel.js";
import { createFindTracker, normalizeStopFindAction } from "../electron/findInPage.js";
import {
  IDENTITY_PROVIDER_HOSTS,
  POPUP_LIMITS,
  blankPopupLeavesApp,
  clampPopupBounds,
  createPopupGate,
  decideWindowOpen,
  isBlankPopupUrl,
  isIdentityProviderUrl,
  popupNavigationLeavesApp,
  popupWindowOptions
} from "../electron/popupPolicy.js";
import { WIPE_DATA_LABEL, iconFileFromSource, removalPlan, removeConfirmOptions, unusedIconFile } from "../electron/serviceRemoval.js";
import { cleanUserAgent } from "../electron/userAgent.js";

test("same-origin pages, about:blank pop-outs and identity providers open as child windows (D13)", () => {
  const discord = { openerUrl: "https://discord.com/channels/1/2", serviceUrl: "https://discord.com/app" };
  assert.equal(decideWindowOpen({ url: "https://discord.com/popout", ...discord }), "popup");
  assert.equal(decideWindowOpen({ url: "", ...discord }), "popup");
  assert.equal(decideWindowOpen({ url: "about:blank", ...discord }), "popup", "Gmail's pop-out compose");
  for (const host of IDENTITY_PROVIDER_HOSTS) {
    assert.equal(decideWindowOpen({ url: `https://${host}/o/oauth2`, ...discord }), "popup", host);
  }
  assert.equal(decideWindowOpen({ url: "https://ACCOUNTS.google.com/x", ...discord }), "popup");
  // The opener may have navigated within its site; the service's own origin still counts.
  assert.equal(decideWindowOpen({ url: "https://mail.google.com/mail/u/0/?view=cm", openerUrl: "https://accounts.google.com/x", serviceUrl: "https://mail.google.com/mail/u/0/" }), "popup");
});

test("other sites, former in-place hosts and non-web schemes go to the link policy", () => {
  const gmail = { openerUrl: "https://mail.google.com/mail/u/0/#inbox", serviceUrl: "https://mail.google.com/mail/u/0/" };
  for (const url of [
    "https://example.com/",
    "https://teams.microsoft.com/l/meetup-join/x",
    "https://slack.com/help",
    "https://discord.com/invite/x",
    "https://www.google.com/url?q=x",
    "https://mail.google.com:8443/x",
    "http://mail.google.com/x",
    "mailto:a@b.example",
    "javascript:alert(1)",
    "file:///C:/Windows/System32/calc.exe",
    "about:srcdoc"
  ]) {
    assert.equal(decideWindowOpen({ url, ...gmail }), "external", url);
  }
  assert.equal(decideWindowOpen({ url: "https://facebook.com/x", openerUrl: "https://www.facebook.com/messages/", serviceUrl: null }), "external", "same site but another origin");
});

test("a blank popup's first page is judged like the window.open() it stands for", () => {
  const gmail = { openerUrl: "https://mail.google.com/mail/u/0/#inbox", serviceUrl: "https://mail.google.com/mail/u/0/" };
  assert.equal(isBlankPopupUrl(undefined), true);
  assert.equal(isBlankPopupUrl(" about:blank "), true);
  assert.equal(isBlankPopupUrl("https://a.example"), false);
  assert.equal(blankPopupLeavesApp({ url: "https://example.com/article", ...gmail }), true, "window.open() then location = link");
  assert.equal(blankPopupLeavesApp({ url: "mailto:a@b.example", ...gmail }), true);
  assert.equal(blankPopupLeavesApp({ url: "https://mail.google.com/mail/u/0/?view=cm", ...gmail }), false, "the app's own pop-out");
  assert.equal(blankPopupLeavesApp({ url: "https://accounts.google.com/signin", ...gmail }), false);
  assert.equal(blankPopupLeavesApp({ url: "about:blank", ...gmail }), false);
});

test("a popup's later navigations are re-checked only when something else started them", () => {
  const gmail = { ownerUrl: "https://mail.google.com/mail/u/0/#inbox", serviceUrl: "https://mail.google.com/mail/u/0/" };
  const leaves = (url, initiatedBySelf) => popupNavigationLeavesApp({ url, initiatedBySelf, ...gmail });
  assert.equal(leaves("https://example.com/article", false), true, "the opener sends the popup to another site");
  assert.equal(leaves("https://example.com/article", undefined), true, "an unknown initiator is not the popup");
  assert.equal(leaves("https://mail.google.com/mail/u/0/?view=cm", false), false, "the app's own origin");
  assert.equal(leaves("https://accounts.google.com/signin", false), false, "an identity provider");
  assert.equal(leaves("about:blank", false), false);
  assert.equal(leaves("https://example.com/article", true), false, "the popup's own links stay in it");
  assert.equal(leaves("https://sso.example-idp.com/saml", true), false, "sign-in chains started by the popup keep working");
  // Judged against the owning service page, not the popup's own URL.
  assert.equal(popupNavigationLeavesApp({ url: "https://partner.example/x", initiatedBySelf: false,
    ownerUrl: "https://mail.google.com/mail/u/0/", serviceUrl: "https://mail.google.com/mail/u/0/" }), true);
});

const workArea = { x: 0, y: 40, width: 1920, height: 1000 };
const insideWorkArea = ({ x, y, width, height }, area = workArea) =>
  x >= area.x && y >= area.y && x + width <= area.x + area.width && y + height <= area.y + area.height;

test("popup windows keep the size the page asked for, inside the work area, and start hidden", () => {
  const plain = popupWindowOptions({ features: "", workArea });
  assert.deepEqual([plain.x, plain.y, plain.width, plain.height], [460, 160, 1000, 760], "a roomy default, centred");
  assert.equal(plain.minWidth, 360);
  assert.equal(plain.minHeight, 320);
  assert.equal(plain.autoHideMenuBar, true);
  assert.equal(plain.show, false);
  const sized = popupWindowOptions({ features: "popup=yes,width=480, height=600", workArea });
  assert.deepEqual([sized.width, sized.height], [480, 600]);
  assert.deepEqual([sized.x, sized.y], [720, 240], "centred when no position is given");
  const placed = popupWindowOptions({ features: "left=100,top=200,width=500,height=400", workArea });
  assert.deepEqual([placed.x, placed.y, placed.width, placed.height], [100, 200, 500, 400]);
  assert.equal(popupWindowOptions({ features: "screenX=30,screenY=90", workArea }).x, 30);
  assert.equal(popupWindowOptions({ features: "innerWidth=400", workArea }).width, 1000, "only width= counts");
  assert.equal(popupWindowOptions().show, false);
  // Without a work area the page's position is still dropped.
  const blind = popupWindowOptions({ features: "left=-5000,top=-5000,width=50" });
  assert.equal("x" in blind && blind.x === undefined && "y" in blind && blind.y === undefined, true);
  assert.equal(blind.width, 360);
});

test("a popup never takes window chrome or an off-screen position from window.open() features (POP-1)", () => {
  // What Electron's own parser makes of such a features string; the handler's options are applied over it.
  const parsed = {
    frame: false, transparent: true, alwaysOnTop: true, fullscreen: true, fullscreenable: false, kiosk: true,
    simpleFullscreen: true, closable: false, minimizable: false, maximizable: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, opacity: 0.05, hasShadow: false, thickFrame: false, enableLargerThanScreen: true,
    titleBarStyle: "hidden", titleBarOverlay: true, hiddenInMissionControl: true, modal: true, useContentSize: true,
    type: "toolbar", maxWidth: 10, maxHeight: 10, x: -5000, y: -5000, width: 9000, height: 9000, show: true
  };
  const features = "frame=no,transparent=yes,alwaysOnTop=yes,fullscreen=yes,kiosk=yes,closable=no,skipTaskbar=yes," +
    "opacity=0.05,type=toolbar,left=-5000,top=-5000,width=9000,height=9000";
  const merged = { show: true, width: 800, height: 600, ...parsed, ...popupWindowOptions({ features, workArea }) };
  assert.equal(merged.frame, true);
  assert.equal(merged.transparent, false);
  assert.equal(merged.alwaysOnTop, false);
  assert.equal(merged.fullscreen, false);
  assert.equal(merged.fullscreenable, true);
  assert.equal(merged.kiosk, false);
  assert.equal(merged.simpleFullscreen, false);
  for (const key of ["closable", "minimizable", "maximizable", "resizable", "movable", "focusable", "hasShadow", "thickFrame"]) {
    assert.equal(merged[key], true, key);
  }
  for (const key of ["skipTaskbar", "enableLargerThanScreen", "titleBarOverlay", "hiddenInMissionControl", "modal", "useContentSize"]) {
    assert.equal(merged[key], false, key);
  }
  assert.equal(merged.opacity, 1);
  assert.equal(merged.titleBarStyle, "default");
  assert.equal(merged.type, undefined, "a toolbar window would leave the taskbar");
  assert.equal(merged.maxWidth, undefined);
  assert.equal(merged.maxHeight, undefined);
  assert.equal(merged.show, false);
  assert.deepEqual([merged.x, merged.y, merged.width, merged.height], [0, 40, 1920, 1000], "clamped into the work area");
  assert.ok(insideWorkArea(merged));
});

test("popup bounds are fitted into the work area of the display", () => {
  const second = { x: -1280, y: 0, width: 1280, height: 984 };
  assert.deepEqual(clampPopupBounds({ x: 5000, y: 5000, width: 600, height: 500 }, second), { x: -600, y: 484, width: 600, height: 500 });
  assert.deepEqual(clampPopupBounds({ x: -9000, y: -10, width: 10, height: 10 }, second), { x: -1280, y: 0, width: 360, height: 320 });
  assert.ok(insideWorkArea(clampPopupBounds({ x: 3, y: 3, width: 4000, height: 4000 }, second), second));
  const tiny = { x: 0, y: 0, width: 300, height: 200 };
  assert.deepEqual(clampPopupBounds({ width: 1000, height: 1000 }, tiny), { x: 0, y: 0, width: 300, height: 200 },
    "a work area smaller than the minimum wins");
  assert.equal(popupWindowOptions({ features: "", workArea: tiny }).minWidth, 300);
  assert.deepEqual(clampPopupBounds({ x: 10, y: 10, width: 500, height: 400 }, { x: 0, y: 0, width: NaN, height: 10 }),
    { x: undefined, y: undefined, width: 500, height: 400 }, "an unusable work area");
});

test("each service may have five popups open and open ten per 30 s (POP-3)", () => {
  let time = 0;
  const gate = createPopupGate({ now: () => time });
  assert.deepEqual({ ...POPUP_LIMITS }, { maxOpen: 5, count: 10, windowMs: 30000 });
  const closers = [];
  for (let index = 0; index < 5; index += 1) {
    assert.equal(gate.admit("gmail"), true, `popup ${index + 1}`);
    closers.push(gate.opened("gmail"));
  }
  assert.equal(gate.openCount("gmail"), 5);
  assert.equal(gate.admit("gmail"), false, "a sixth open popup is refused");
  assert.equal(gate.admit("discord"), true, "other services have their own count");
  assert.equal(gate.admit(null), false);
  closers[0]();
  closers[0]();
  assert.equal(gate.openCount("gmail"), 4, "closing frees one slot, once");
  assert.equal(gate.admit("gmail"), true);
  assert.equal(gate.admit("gmail"), false, "an admitted popup holds its slot until its window exists");
  time += 5000;
  assert.equal(gate.admit("gmail"), true, "a slot whose window never appeared is freed after a while");
  gate.opened("gmail");
  for (const close of closers) close();
  // Seven admitted so far in this 30 s; opening and closing more is limited by rate as well.
  let admitted = 0;
  for (let index = 0; index < 10; index += 1) {
    if (gate.admit("gmail")) {
      admitted += 1;
      gate.opened("gmail")();
    }
  }
  assert.equal(admitted, 3, "at most ten new popups per 30 s");
  time += 30000;
  assert.equal(gate.admit("gmail"), true, "the rate limit recovers");
});

test("identity providers are recognised by their https sign-in hosts", () => {
  assert.equal(isIdentityProviderUrl("https://accounts.google.com"), true);
  assert.equal(isIdentityProviderUrl("https://LOGIN.microsoftonline.com/x"), true);
  assert.equal(isIdentityProviderUrl("http://accounts.google.com"), false);
  assert.equal(isIdentityProviderUrl("https://accounts.google.com.example"), false);
  assert.equal(isIdentityProviderUrl("null"), false);
  assert.equal(isIdentityProviderUrl(null), false);
});

test("the guest user agent drops Electron and app tokens and uses Chrome's reduced version (D15)", () => {
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) comms-app/1.3.0 Chrome/152.0.7977.169 Electron/44.10.0 Safari/537.36";
  const expected = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const options = { chromeVersion: "152.0.7977.169", appNames: ["Comms Hub", "comms-app", undefined, ""] };
  assert.equal(cleanUserAgent(windows, options), expected);
  assert.equal(cleanUserAgent(windows.replace("comms-app/1.3.0", "Comms Hub/1.3.0"), options), expected, "product names with spaces");
  assert.equal(cleanUserAgent(expected, options), expected, "idempotent");
  const macUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Comms Hub/1.3.0 Chrome/152.0.7977.169 Electron/44.10.0 Safari/537.36";
  assert.equal(cleanUserAgent(macUa, options), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
  assert.match(cleanUserAgent(windows, { appNames: ["comms-app"] }), /Chrome\/152\.0\.7977\.169 Safari/, "no version given: Chrome token kept");
});

test("the old fixed Chrome/135 user agent is dropped from stored services; other overrides stay", () => {
  const legacy = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
  const wechat = normalizeService({ id: "w", url: "https://web.wechat.com/", userAgent: legacy });
  assert.equal(wechat.userAgent, null);
  assert.equal(wechat.useDefaultSession, true, "WeChat still uses the default session");
  assert.equal(normalizeService({ id: "w2", url: "https://wx.qq.com/" }).userAgent, null);
  assert.equal(normalizeService({ id: "c", url: "https://c.example", userAgent: "Custom/1" }).userAgent, "Custom/1");
  assert.equal(normalizeService({ id: "teams" }).userAgent, null, "Teams no longer pins Chrome 135");
});

test("find: new searches, next matches, switching pages and stopping", () => {
  const find = createFindTracker();
  const host = { id: "host" };
  assert.equal(find.request({ contentsId: 1, text: "" }), null);
  assert.equal(find.request({ contentsId: null, text: "x" }), null);
  const first = find.request({ contentsId: 1, text: "hello", replyTo: host });
  assert.deepEqual(first, { text: "hello", options: { forward: true, findNext: true, matchCase: false }, previous: null });
  assert.equal(find.replyTargetFor(1), host);
  assert.equal(find.replyTargetFor(2), null);
  const next = find.request({ contentsId: 1, text: "hello", findNext: true, forward: false, replyTo: host });
  assert.deepEqual(next.options, { forward: false, findNext: false, matchCase: false }, "Electron's findNext=false continues the session");
  assert.equal(find.request({ contentsId: 1, text: "hello!", findNext: true }).options.findNext, true, "new text: new session");
  assert.equal(find.request({ contentsId: 1, text: "hello!", findNext: true, matchCase: true }).options.findNext, true);
  const moved = find.request({ contentsId: 2, text: "hello!", findNext: true, replyTo: host });
  assert.equal(moved.previous, 1, "the old page's highlights are cleared");
  assert.equal(moved.options.findNext, true);
  assert.equal(find.request({ contentsId: 2, text: "x".repeat(600), replyTo: host }).text.length, 500);
  find.forget(3);
  assert.notEqual(find.replyTargetFor(2), null);
  assert.equal(find.stop(), 2);
  assert.equal(find.stop(), null);
  find.request({ contentsId: 4, text: "a" });
  find.forget(4);
  assert.equal(find.replyTargetFor(4), null);
  assert.equal(normalizeStopFindAction("keepSelection"), "keepSelection");
  assert.equal(normalizeStopFindAction("drop tables"), "clearSelection");
});

test("removal plan: only the app's own partition and unshared uploaded icon", () => {
  const iconsDir = "C:\\Users\\me\\AppData\\Roaming\\Comms Hub\\icons";
  const icon = "file:///C:/Users/me/AppData/Roaming/Comms%20Hub/icons/abc.png";
  const target = { id: "t", sessionPartition: "persist:service-t", useDefaultSession: false, iconSource: icon };
  const others = [{ id: "o", sessionPartition: "persist:service-o", iconSource: "data:image/svg+xml,x" }];
  assert.deepEqual(removalPlan({ target, services: [target, ...others], iconsDir, platform: "win32" }), {
    partition: "persist:service-t",
    iconPath: `${iconsDir}\\abc.png`
  });
  const shared = removalPlan({ target, services: [target, { id: "o", sessionPartition: "persist:service-t", iconSource: icon }], iconsDir, platform: "win32" });
  assert.deepEqual(shared, { partition: null, iconPath: null }, "shared partitions and icons are kept");
  const defaultSession = removalPlan({ target: { ...target, sessionPartition: null, useDefaultSession: true }, services: [], iconsDir, platform: "win32" });
  assert.equal(defaultSession.partition, null, "the default session is never wiped");
  assert.equal(removalPlan({ target: { ...target, iconSource: "data:image/png;base64,AA" }, services: [], iconsDir, platform: "win32" }).iconPath, null);
});

test("uploaded icon paths must stay inside the icons folder", () => {
  const iconsDir = "C:\\Data\\icons";
  assert.equal(iconFileFromSource("file:///C:/Data/icons/a.png", { iconsDir, platform: "win32" }), "C:\\Data\\icons\\a.png");
  assert.equal(iconFileFromSource("file://C:/Data/icons/legacy.png", { iconsDir, platform: "win32" }), "C:\\Data\\icons\\legacy.png", "older builds' format");
  assert.equal(iconFileFromSource("file:///C:/Data/icons/../secrets.txt", { iconsDir, platform: "win32" }), null);
  assert.equal(iconFileFromSource("file:///C:/Windows/win.ini", { iconsDir, platform: "win32" }), null);
  assert.equal(iconFileFromSource("file://server/share/icons/a.png", { iconsDir, platform: "win32" }), null);
  assert.equal(iconFileFromSource("https://example.com/a.png", { iconsDir, platform: "win32" }), null);
  assert.equal(iconFileFromSource("file:///home/me/.config/Comms Hub/icons/a.png", { iconsDir: "/home/me/.config/Comms Hub/icons", platform: "posix" }), "/home/me/.config/Comms Hub/icons/a.png");
  assert.equal(iconFileFromSource("file:///C:/Data/icons/a.png", { iconsDir: null, platform: "win32" }), null);
  const uncDir = "\\\\fileserver\\profiles$\\gary\\Comms Hub\\icons";
  assert.equal(
    iconFileFromSource("file://fileserver/profiles$/gary/Comms%20Hub/icons/a.png", { iconsDir: uncDir, platform: "win32" }),
    `${uncDir}\\a.png`,
    "an icons folder on a server can clean up its own files"
  );
  assert.equal(iconFileFromSource("file://otherhost/profiles$/gary/Comms%20Hub/icons/a.png", { iconsDir: uncDir, platform: "win32" }), null);
});

test("a replaced upload is unused only when no app shows the same file", () => {
  const iconsDir = "C:\\Users\\me\\AppData\\Roaming\\Comms Hub\\icons";
  const options = (services) => ({ services, iconsDir, platform: "win32" });
  const icon = "file:///C:/Users/me/AppData/Roaming/Comms%20Hub/icons/abc.png";
  const legacy = "file://C:/Users/me/AppData/Roaming/Comms Hub/icons/abc.png";
  const other = { id: "o", iconSource: "file:///C:/Users/me/AppData/Roaming/Comms%20Hub/icons/other.png" };
  assert.equal(unusedIconFile(icon, options([other, { id: "t", iconSource: "data:image/svg+xml,x" }])), `${iconsDir}\\abc.png`);
  assert.equal(unusedIconFile(legacy, options([other])), `${iconsDir}\\abc.png`, "the old two-slash form names the same file");
  assert.equal(unusedIconFile(legacy, options([{ id: "s", iconSource: icon }])), null, "old and new forms of one file are matched");
  assert.equal(unusedIconFile(icon, options([{ id: "s", iconSource: icon.replace("abc.png", "ABC.png") }])), null, "Windows paths ignore case");
  assert.equal(unusedIconFile(icon, options([{ id: "s", iconSource: icon }])), null, "a shared icon is kept");
  assert.equal(unusedIconFile("data:image/png;base64,AA", options([])), null, "only uploaded files are deleted");
  assert.equal(unusedIconFile("file:///C:/Windows/win.ini", options([])), null, "never a file outside the icons folder");
  assert.equal(unusedIconFile(undefined, options([])), null);
});

test("the remove confirm defaults to Cancel and offers an unchecked wipe box only when there is data to wipe (D7)", () => {
  const withWipe = removeConfirmOptions({ name: "Notes", canWipeData: true });
  assert.equal(withWipe.message, "Remove Notes?");
  assert.deepEqual(withWipe.buttons, ["Remove", "Cancel"]);
  assert.deepEqual([withWipe.defaultId, withWipe.cancelId], [1, 1]);
  assert.equal(withWipe.checkboxLabel, WIPE_DATA_LABEL);
  assert.equal(withWipe.checkboxChecked, false);
  const withoutWipe = removeConfirmOptions({ name: "WeChat", canWipeData: false });
  assert.equal("checkboxLabel" in withoutWipe, false);
});
