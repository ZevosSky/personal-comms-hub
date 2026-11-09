import assert from "node:assert/strict";
import test from "node:test";
import {
  OVERLAY_BADGE_MAX_BYTES,
  badgeCountsFor,
  overlayDescription,
  parseBadgeCount,
  parseOverlayBadge,
  titleFormatFor
} from "../electron/badges.js";
import { builtInServices, normalizeService } from "../electron/appStateModel.js";

const builtIn = (id) => builtInServices.find((service) => service.id === id);
const custom = (url) => ({ id: "custom", url });

test("Gmail: only the inbox count is trusted; thread and label pages say nothing", () => {
  const gmail = builtIn("gmail");
  for (const [title, expected] of [
    ["Inbox (3) - a@b.com - Gmail", 3],
    ["Inbox (1,234) - a@b.com - Gmail", 1234],
    ["Inbox (1.234) - someone@company.de - Gmail", 1234],
    ["Primary (12) - a@b.com - Gmail", 12],
    ["Posteingang (5) - a@b.de - Gmail", 5],
    ["Inbox - a@b.com - Gmail", 0],
    ["Re: invoice (2) - a@b.com - Gmail", null],
    ["Re: plan (2025) - a@b.com - Gmail", null],
    ["Starred - a@b.com - Gmail", null],
    ["Gmail", null],
    ["", null]
  ]) {
    assert.equal(parseBadgeCount(title, gmail), expected, title);
  }
  // A second Gmail account added as a custom app is read the same way.
  assert.equal(parseBadgeCount("Inbox (7) - work@x.com - Gmail", custom("https://mail.google.com/mail/u/1/")), 7);
});

test("Discord, Messenger and Teams use a leading count and drop it when everything is read", () => {
  for (const [id, title, expected] of [
    ["discord", "(3) Discord | #general | Server", 3],
    ["discord", "Discord | #general | Server", 0],
    ["discord", "• Discord | #general", 0],
    ["discord", "(99+) Discord", 99],
    ["messenger", "(1) Messenger | Facebook", 1],
    ["messenger", "Messenger | Facebook", 0],
    ["messenger", "Bob Smith messaged you", null],
    ["messenger", "Bob sent you a message", null],
    ["teams", "(2) Chat | Microsoft Teams", 2],
    ["teams", "Chat | Microsoft Teams", 0],
    ["teams", "Alice is calling", null]
  ]) {
    assert.equal(parseBadgeCount(title, builtIn(id)), expected, `${id}: ${title}`);
  }
  assert.equal(parseBadgeCount("(4) WhatsApp", custom("https://web.whatsapp.com/")), 4);
});

test("Slack titles carry no count, and Slack's badge comes from notifications", () => {
  const slack = builtIn("slack");
  assert.equal(titleFormatFor(slack), "none");
  assert.equal(parseBadgeCount("Slack | general | Acme", slack), null);
  assert.equal(parseBadgeCount("(2) anything", slack), null);
  assert.equal(slack.supportsBadgeDetection, false);
  assert.equal(normalizeService({ id: "slack", supportsBadgeDetection: true }).supportsBadgeDetection, false);
});

test("other apps: a leading count or an inbox count; never a number in the middle of a title", () => {
  const site = custom("https://chat.example.com/");
  for (const [title, expected] of [
    ["(5) Example Chat", 5],
    ["[12] Mailbox", 12],
    ["Inbox (8) | Example Mail", 8],
    ["Example Chat", 0],
    ["Quarterly report (2025) - Docs", 0],
    ["[2026] Roadmap", 0],
    ["(2024) Annual review", 0],
    ["(1899) Example Chat", 1899],
    ["(2026+) Example Chat", 2026],
    ["Dana messaged you", null]
  ]) {
    assert.equal(parseBadgeCount(title, site), expected, title);
  }
  assert.equal(titleFormatFor(custom("not a url")), "generic");
});

test("badge counts show only for the page that reported them and only when badges are on", () => {
  const services = [
    { id: "a", isEnabled: true, supportsBadgeDetection: true, notificationSettings: { badgeEnabled: true } },
    { id: "b", isEnabled: true, supportsBadgeDetection: true, notificationSettings: { badgeEnabled: false } },
    { id: "c", isEnabled: true, supportsBadgeDetection: false, notificationSettings: { badgeEnabled: true } },
    { id: "d", isEnabled: false, supportsBadgeDetection: true, notificationSettings: { badgeEnabled: true } },
    { id: "e", isEnabled: true, supportsBadgeDetection: true, notificationSettings: { badgeEnabled: true } },
    { id: "f", isEnabled: true, supportsBadgeDetection: true, notificationSettings: { badgeEnabled: true } }
  ];
  const titleCounts = new Map(["a", "b", "c", "d", "e", "f"].map((id) => [id, { count: 4, webContentsId: 1 }]));
  const runtimeServices = {
    a: { webContentsId: 1 }, b: { webContentsId: 1 }, c: { webContentsId: 1 }, d: { webContentsId: null },
    e: { webContentsId: 2 }, f: { webContentsId: null }
  };
  assert.deepEqual(badgeCountsFor({ services, runtimeServices, titleCounts }), { a: 4, b: 0, c: 0, d: 0, e: 0, f: 0 },
    "turned off, unsupported, disabled, a recreated page and a sleeping page all read 0");
  assert.deepEqual(badgeCountsFor({ services: services.slice(0, 1), runtimeServices: {} }), { a: 0 });
});

test("overlay badges accept small PNG data URLs, and null or zero clears", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.deepEqual(parseOverlayBadge({ count: 3, dataUrl: png }), { count: 3, dataUrl: png });
  assert.deepEqual(parseOverlayBadge({ count: 3.7, dataUrl: png }), { count: 3, dataUrl: png });
  assert.deepEqual(parseOverlayBadge(null), { count: 0, dataUrl: null });
  assert.deepEqual(parseOverlayBadge({ count: 5, dataUrl: null }), { count: 5, dataUrl: null });
  assert.deepEqual(parseOverlayBadge({ count: 0, dataUrl: png }), { count: 0, dataUrl: null });
  for (const bad of [
    undefined, "x", [], { count: -1, dataUrl: png }, { count: "lots", dataUrl: png },
    { count: 1, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
    { count: 1, dataUrl: "https://example.com/badge.png" },
    { count: 1, dataUrl: `data:image/png;base64,${"A".repeat(OVERLAY_BADGE_MAX_BYTES)}` },
    { count: 1, dataUrl: "data:image/png;base64,<script>" }
  ]) {
    assert.equal(parseOverlayBadge(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.equal(overlayDescription(2), "2 unread");
  assert.equal(overlayDescription(5000), "999+ unread");
  assert.equal(overlayDescription(0), "");
});
