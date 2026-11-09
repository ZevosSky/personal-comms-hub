import assert from "node:assert/strict";
import test from "node:test";
import { classifyExternalUrl, createExternalOpener, createRateLimiter } from "../electron/linkPolicy.js";

test("external URLs are classified per the link policy", () => {
  const cases = [
    ["https://example.org/path?q=1", "open"],
    ["http://example.org/", "open"],
    ["  https://example.org/padded  ", "open"],
    ["HTTPS://EXAMPLE.ORG/", "open"],
    ["mailto:someone@example.com", "open"],
    ["tel:+15551234567", "open"],
    ["msteams:/l/meetup-join/abc", "confirm"],
    ["slack://open?team=T1", "confirm"],
    ["discord://discord.com/channels/1", "confirm"],
    ["zoommtg://zoom.us/join?confno=1", "confirm"],
    ["zoomus://zoom.us/join", "confirm"],
    ["tg://resolve?domain=x", "confirm"],
    ["whatsapp://send?text=hi", "confirm"],
    ["skype:echo123?call", "confirm"],
    ["webcal://example.org/cal.ics", "confirm"],
    ["spotify:track:1", "confirm"],
    ["ms-word:ofe|u|https://example.sharepoint.com/doc.docx", "confirm"],
    ["steam://run/1", "confirm"],
    ["file:///C:/Windows/System32/calc.exe", "block"],
    ["FILE:///C:/x.exe", "block"],
    ["file://server/share/x.exe", "block"],
    ["\\\\server\\share\\x.exe", "block"],
    ["//server/share/x.exe", "block"],
    ["C:\\Windows\\System32\\calc.exe", "block"],
    ["javascript:alert(1)", "block"],
    [" JavaScript:alert(1)", "block"],
    ["data:text/html,<script>alert(1)</script>", "block"],
    ["vbscript:msgbox(1)", "block"],
    ["blob:https://example.org/uuid", "block"],
    ["about:blank", "block"],
    ["smb://server/share", "block"],
    ["search-ms:query=x&crumb=location:\\\\evil\\share", "block"],
    ["search:query=x", "block"],
    ["ms-msdt:/id PCWDiagnostic", "block"],
    ["ms-officecmd:{}", "block"],
    ["ms-settings:privacy", "block"],
    ["MS-SETTINGS:", "block"],
    ["ms-cxh-full://0", "block"],
    ["ms-cxh://x", "block"],
    ["shell:startup", "block"],
    ["https://", "block"],
    ["", "block"],
    [null, "block"],
    ["not a url", "block"],
    [`https://example.org/${"a".repeat(9000)}`, "block"]
  ];
  for (const [input, action] of cases) {
    assert.equal(classifyExternalUrl(input).action, action, `${String(input).slice(0, 60)} -> ${action}`);
  }
});

test("classification hands the OS a normalized URL and names known apps", () => {
  assert.equal(classifyExternalUrl("  https://Example.org  ").url, "https://example.org/");
  assert.equal(classifyExternalUrl("zoommtg://zoom.us/join").appName, "Zoom");
  assert.equal(classifyExternalUrl("steam://run/1").appName, null);
  assert.equal(classifyExternalUrl("search-ms:query=x").scheme, "search-ms:");
});

test("the rate limiter uses a sliding window per key", () => {
  let now = 0;
  const take = createRateLimiter({ count: 2, windowMs: 1000, now: () => now });
  assert.equal(take("a"), true);
  assert.equal(take("a"), true);
  assert.equal(take("a"), false);
  assert.equal(take("b"), true);
  now = 1001;
  assert.equal(take("a"), true);
});

const createHarness = (overrides = {}) => {
  let now = 0;
  const opened = [];
  const prompts = [];
  const blocked = [];
  const dropped = [];
  const opener = createExternalOpener({
    openExternal: async (url) => { opened.push(url); },
    confirm: async (verdict, context) => {
      prompts.push({ verdict, context });
      return overrides.answer ?? true;
    },
    onBlocked: (verdict) => blocked.push(verdict.scheme),
    onDropped: (verdict) => dropped.push(verdict.scheme),
    now: () => now,
    ...overrides.options
  });
  return { opener, opened, prompts, blocked, dropped, tick: (ms) => { now += ms; } };
};

test("web links open directly, blocked links never reach the OS", async () => {
  const { opener, opened, prompts, blocked } = createHarness();
  assert.equal(await opener.open("https://example.org/", { source: 1 }), "opened");
  assert.equal(await opener.open("search-ms:query=x", { source: 1 }), "blocked");
  assert.equal(await opener.open("file:///C:/x.exe", { source: 1 }), "blocked");
  assert.deepEqual(opened, ["https://example.org/"]);
  assert.deepEqual(prompts, []);
  assert.deepEqual(blocked, ["search-ms:", "file:"]);
});

test("app links ask first and open only when confirmed", async () => {
  const yes = createHarness({ answer: true });
  assert.equal(await yes.opener.open("zoommtg://zoom.us/join", { source: 1, serviceName: "Slack" }), "opened");
  assert.equal(yes.prompts[0].context.serviceName, "Slack");
  assert.deepEqual(yes.opened, ["zoommtg://zoom.us/join"]);

  const no = createHarness({ answer: false });
  assert.equal(await no.opener.open("zoommtg://zoom.us/join", { source: 1 }), "cancelled");
  assert.deepEqual(no.opened, []);
});

test("only one prompt is shown at a time and each source has a prompt budget", async () => {
  let release;
  const prompts = [];
  const opener = createExternalOpener({
    openExternal: async () => {},
    confirm: (verdict) => {
      prompts.push(verdict.url);
      return new Promise((resolve) => { release = resolve; });
    }
  });
  const first = opener.open("steam://run/1", { source: 1 });
  assert.equal(await opener.open("steam://run/2", { source: 1 }), "dropped", "a second prompt while one is open is dropped");
  assert.equal(await opener.open("steam://run/3", { source: 2 }), "dropped", "even from another page");
  release(false);
  assert.equal(await first, "cancelled");

  const { opener: budgeted, prompts: asked } = createHarness({ answer: false });
  for (let index = 0; index < 3; index += 1) assert.equal(await budgeted.open("steam://run/1", { source: 7 }), "cancelled");
  assert.equal(await budgeted.open("steam://run/1", { source: 7 }), "dropped", "a page cannot loop prompts");
  assert.equal(asked.length, 3);
});

test("direct opens are rate-limited per source", async () => {
  const { opener, opened, dropped, tick } = createHarness();
  for (let index = 0; index < 3; index += 1) assert.equal(await opener.open(`https://example.org/${index}`, { source: 1 }), "opened");
  assert.equal(await opener.open("https://example.org/spam", { source: 1 }), "dropped");
  assert.equal(await opener.open("https://example.org/other", { source: 2 }), "opened");
  tick(5001);
  assert.equal(await opener.open("https://example.org/later", { source: 1 }), "opened");
  assert.equal(opened.length, 5);
  assert.deepEqual(dropped, ["https:"]);
});

test("open failures and prompt errors are contained", async () => {
  const logs = [];
  const failing = createExternalOpener({
    openExternal: async () => { throw new Error("no handler"); },
    confirm: async () => { throw new Error("dialog failed"); },
    log: (message) => logs.push(message)
  });
  assert.equal(await failing.open("https://example.org/"), "failed");
  assert.equal(await failing.open("steam://run/1"), "cancelled");
  assert.equal(logs.length, 2);
});
