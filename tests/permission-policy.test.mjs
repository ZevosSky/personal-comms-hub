import assert from "node:assert/strict";
import test from "node:test";
import {
  PERMISSION_KEYS,
  createPermissionPrompter,
  decidePermissionCheck,
  decidePermissionRequest,
  mediaRequestKeys,
  permissionPromptAnswer,
  permissionPromptOptions,
  requestingOriginOf
} from "../electron/permissionPolicy.js";
import { siteAliasesFor } from "../electron/appStateModel.js";

const teams = { url: "https://teams.microsoft.com/v2/" };
const noDecisions = () => null;
const decisions = (map) => (key) => map[key] ?? null;
const request = (overrides) =>
  decidePermissionRequest({
    permission: "media",
    mediaTypes: ["audio", "video"],
    origin: "https://teams.microsoft.com",
    service: teams,
    ownedAliases: [],
    decisionFor: noDecisions,
    ...overrides
  });

test("media request keys: camera, microphone, or screen capture when no device is named", () => {
  assert.deepEqual(mediaRequestKeys(["video"]), ["camera"]);
  assert.deepEqual(mediaRequestKeys(["audio", "video"]), ["camera", "microphone"]);
  assert.deepEqual(mediaRequestKeys([]), ["display-capture"]);
  assert.deepEqual(mediaRequestKeys(undefined), ["display-capture"]);
});

test("camera and microphone are automatic for the service's own site", () => {
  assert.deepEqual(request({}), { action: "allow", keys: ["camera", "microphone"] });
  assert.equal(request({ origin: "https://teams.cloud.microsoft", ownedAliases: siteAliasesFor({ id: "teams", isBuiltIn: true }) }).action, "allow",
    "a built-in's alias counts");
  assert.equal(request({ origin: "https://chat.example", service: { url: "https://example.com/" }, ownedAliases: ["https://chat.example/home"] }).action,
    "allow", "the page the home address landed on counts");
  assert.equal(request({ origin: "https://mail.google.com", service: { url: "https://mail.google.com/mail/u/0/" } }).action, "allow");
});

test("the page the view or a popup shows now never makes its site the service's own", () => {
  const offSite = { origin: "https://unrelated.example", topLevelUrl: "https://unrelated.example/page" };
  assert.deepEqual(request(offSite), { action: "prompt", keys: ["camera", "microphone"] });
  assert.equal(request({ ...offSite, ownedAliases: siteAliasesFor({ id: "teams", isBuiltIn: true }) }).action, "prompt");
  assert.deepEqual(request({ ...offSite, mediaTypes: [] }),
    { action: "screen-picker", keys: ["display-capture"], foreignOrigin: "https://unrelated.example" },
    "screen capture goes to the picker, which names the site");
  assert.equal(request({ ...offSite, permission: "display-capture", mediaTypes: undefined }).foreignOrigin, "https://unrelated.example");
  assert.equal(decidePermissionCheck({ permission: "media", mediaType: "audio", service: teams, decisionFor: noDecisions, ...offSite }), false);
  assert.equal(decidePermissionCheck({ permission: "media", mediaType: "video", service: teams, decisionFor: noDecisions, ...offSite }), false);
});

test("another site under a multi-label public suffix is not the service's own", () => {
  const acme = { url: "https://chat.acme.com.pk/" };
  assert.equal(request({ service: acme, origin: "https://chat.acme.com.pk" }).action, "allow");
  assert.equal(request({ service: acme, origin: "https://other-company.com.pk" }).action, "prompt");
  const tenant = { url: "https://team.azurestaticapps.net/" };
  assert.equal(request({ service: tenant, origin: "https://someone-else.azurestaticapps.net" }).action, "prompt");
});

test("other origins are asked about unless a decision was remembered; Block always wins", () => {
  const ad = { origin: "https://ads.example" };
  assert.deepEqual(request(ad), { action: "prompt", keys: ["camera", "microphone"] });
  assert.equal(request({ ...ad, decisionFor: decisions({ camera: "allow", microphone: "allow" }) }).action, "allow");
  assert.equal(request({ ...ad, decisionFor: decisions({ camera: "allow" }) }).action, "prompt", "every requested device must be allowed");
  assert.equal(request({ ...ad, decisionFor: decisions({ microphone: "block" }) }).action, "deny");
  assert.equal(request({ decisionFor: decisions({ camera: "block" }) }).action, "deny", "a stale allow never bypasses a Block");
});

test("screen capture is never granted without the picker, only blocked by a remembered Block", () => {
  // Legacy desktop constraints arrive here like getDisplayMedia and capture as soon as this is granted.
  assert.deepEqual(request({ mediaTypes: [] }), { action: "screen-picker", keys: ["display-capture"], foreignOrigin: null },
    "the service's own site still picks a source");
  assert.deepEqual(request({ mediaTypes: [], origin: "https://ads.example" }),
    { action: "screen-picker", keys: ["display-capture"], foreignOrigin: "https://ads.example" });
  assert.equal(request({ mediaTypes: [], origin: "https://ads.example", decisionFor: decisions({ "display-capture": "allow" }) }).action,
    "screen-picker", "a remembered Allow does not skip the picker");
  assert.equal(request({ mediaTypes: [], decisionFor: decisions({ "display-capture": "block" }) }).action, "deny");
  assert.equal(request({ mediaTypes: [], origin: "https://ads.example", decisionFor: decisions({ "display-capture": "block" }) }).action, "deny");
  assert.equal(request({ permission: "display-capture", mediaTypes: undefined }).action, "screen-picker");
  assert.equal(request({ mediaTypes: [], service: null }).action, "deny");
});

test("non-service pages, non-web frames and unknown permissions are denied", () => {
  assert.equal(request({ service: null }).action, "deny");
  assert.equal(request({ origin: null }).action, "deny");
  for (const permission of ["geolocation", "midi", "clipboard-read", "hid", "usb", "serial", "pointerLock", "storage-access", "speaker-selection"]) {
    assert.equal(request({ permission }).action, "deny", permission);
  }
  assert.equal(request({ permission: "notifications" }).action, "allow");
  assert.equal(request({ permission: "notifications", service: null }).action, "allow", "notifications are routed by Comms Hub");
  assert.equal(request({ permission: "notifications", origin: null }).action, "deny", "not for file: shell pages");
  assert.equal(request({ permission: "fullscreen" }).action, "allow");
  assert.equal(request({ permission: "clipboard-sanitized-write" }).action, "allow");
  assert.equal(request({ permission: "openExternal" }).action, "open-external");
});

test("permission checks agree with requests", () => {
  const check = (overrides) =>
    decidePermissionCheck({
      permission: "media",
      mediaType: "audio",
      origin: "https://teams.microsoft.com",
      service: teams,
      ownedAliases: [],
      decisionFor: noDecisions,
      ...overrides
    });
  assert.equal(check({}), true);
  assert.equal(check({ decisionFor: decisions({ microphone: "block" }) }), false, "a Block is never reported as granted");
  assert.equal(check({ origin: "https://ads.example" }), false, "an origin that would be asked is not granted yet");
  assert.equal(check({ origin: "https://ads.example", decisionFor: decisions({ microphone: "allow" }) }), true);
  assert.equal(check({ mediaType: "video", decisionFor: decisions({ camera: "block" }) }), false);
  assert.equal(check({ mediaType: undefined, decisionFor: decisions({ camera: "block" }) }), true, "the microphone is still usable");
  assert.equal(check({ permission: "speaker-selection", mediaType: undefined }), true, "speakers follow the microphone");
  assert.equal(check({ permission: "display-capture", mediaType: undefined }), false, "screen capture always goes through the picker");
  assert.equal(check({ permission: "display-capture", mediaType: undefined, decisionFor: decisions({ "display-capture": "allow" }) }), false);
  assert.equal(check({ service: null }), false);
  assert.equal(check({ permission: "notifications", service: null }), true);
  assert.equal(check({ permission: "notifications", origin: null }), false);
  assert.equal(check({ permission: "geolocation" }), false);
});

test("the requesting origin comes from the frame URL, then the security origin", () => {
  assert.equal(requestingOriginOf({ requestingUrl: "https://a.example/x", securityOrigin: "https://b.example/" }), "https://a.example");
  assert.equal(requestingOriginOf({ securityOrigin: "http://127.0.0.1:5000/" }), "http://127.0.0.1:5000");
  assert.equal(requestingOriginOf({}, "https://c.example/"), "https://c.example");
  assert.equal(requestingOriginOf({ requestingUrl: "file:///C:/x" }), null);
});

test("prompt options offer Allow/Block/Not now with Remember checked; dismissing is Not now", () => {
  const options = permissionPromptOptions({ serviceName: "Slack", origin: "https://ads.example", keys: ["camera", "microphone"] });
  assert.deepEqual(options.buttons, ["Allow", "Block", "Not now"]);
  assert.equal(options.cancelId, 2);
  assert.equal(options.defaultId, 2);
  assert.equal(options.checkboxLabel, "Remember for this app");
  assert.equal(options.checkboxChecked, true);
  assert.match(options.message, /Slack wants to use your camera and microphone/);
  assert.match(options.detail, /ads\.example/);
  assert.match(permissionPromptOptions({ serviceName: "S", origin: "o", keys: [PERMISSION_KEYS.screen] }).message, /share your screen/);
});

test("only Allow or Block with the box ticked is remembered", () => {
  assert.deepEqual(permissionPromptAnswer({ response: 0, checkboxChecked: true }), { allow: true, remember: true });
  assert.deepEqual(permissionPromptAnswer({ response: 1, checkboxChecked: true }), { allow: false, remember: true });
  assert.deepEqual(permissionPromptAnswer({ response: 1, checkboxChecked: false }), { allow: false, remember: false });
  // Esc, closing the prompt or Enter answer "Not now" with the box still ticked.
  assert.deepEqual(permissionPromptAnswer({ response: 2, checkboxChecked: true }), { allow: false, remember: false });
  assert.deepEqual(permissionPromptAnswer(undefined), { allow: false, remember: false });
});

test("the prompter shares one prompt per request, remembers on request and limits prompts", async () => {
  let now = 0;
  const shown = [];
  const remembered = [];
  const answers = [];
  const prompter = createPermissionPrompter({
    showPrompt: (details) => {
      shown.push(details);
      return new Promise((resolve) => answers.push(resolve));
    },
    remember: (...args) => remembered.push(args),
    now: () => now
  });
  const ask = (origin = "https://ads.example") =>
    prompter.request({ serviceId: "slack", serviceName: "Slack", origin, keys: ["camera", "microphone"] });

  const first = ask();
  const same = ask();
  await Promise.resolve();
  assert.equal(shown.length, 1, "identical concurrent requests share one prompt");
  answers[0]({ allow: true, remember: true });
  assert.deepEqual(await Promise.all([first, same]), [true, true]);
  assert.deepEqual(remembered, [
    ["slack", "https://ads.example", "camera", "allow"],
    ["slack", "https://ads.example", "microphone", "allow"]
  ]);

  const blocked = ask("https://other.example");
  await Promise.resolve();
  answers[1]({ allow: false, remember: false });
  assert.equal(await blocked, false);
  assert.equal(remembered.length, 2, "nothing is remembered when the box is unticked");

  const third = ask("https://third.example");
  await Promise.resolve();
  answers[2]({ allow: false, remember: true });
  assert.equal(await third, false);
  assert.deepEqual(remembered.at(-1), ["slack", "https://third.example", "microphone", "block"]);

  assert.equal(await ask("https://fourth.example"), false, "a fourth prompt within a minute is denied without asking");
  assert.equal(shown.length, 3);
  now = 60001;
  const later = ask("https://fourth.example");
  await Promise.resolve();
  assert.equal(shown.length, 4);
  answers[3]({ allow: true });
  assert.equal(await later, true);

  const notNow = ask("https://fifth.example");
  await Promise.resolve();
  answers[4](permissionPromptAnswer({ response: 2, checkboxChecked: true }));
  assert.equal(await notNow, false);
  assert.deepEqual(remembered.at(-1), ["slack", "https://third.example", "microphone", "block"], "Not now stores nothing");

  // An Allow for screen capture is never kept (it needs a fresh pick); a Block is.
  const screenRemembered = [];
  const screenPrompter = createPermissionPrompter({ showPrompt: async (details) => details.answer, remember: (...args) => screenRemembered.push(args) });
  const askScreen = (origin, answer) =>
    screenPrompter.request({ serviceId: "slack", serviceName: "Slack", origin, keys: [PERMISSION_KEYS.screen], answer });
  assert.equal(await askScreen("https://a.example", { allow: true, remember: true }), true);
  assert.equal(await askScreen("https://b.example", { allow: false, remember: true }), false);
  assert.deepEqual(screenRemembered, [["slack", "https://b.example", "display-capture", "block"]]);

  const failing = createPermissionPrompter({ showPrompt: () => { throw new Error("no dialog"); }, remember: () => {} });
  assert.equal(await failing.request({ serviceId: "a", origin: "https://x.example", keys: ["camera"] }), false);
});
