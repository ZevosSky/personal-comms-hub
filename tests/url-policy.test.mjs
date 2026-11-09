import assert from "node:assert/strict";
import test from "node:test";
import { siteAliasesFor } from "../electron/appStateModel.js";
import {
  createShellDocumentMatcher,
  isGitHubReleaseUrl,
  isSameSite,
  isServiceOwnedUrl,
  normalizeServiceUrl,
  originOf,
  siteOfHost
} from "../electron/urlPolicy.js";

test("service addresses must be http(s); bare hosts get https", () => {
  const ok = (input, url, insecure = false) => assert.deepEqual(normalizeServiceUrl(input), { ok: true, url, insecure, error: null });
  ok("mail.google.com", "https://mail.google.com/");
  ok("  https://app.slack.com/client  ", "https://app.slack.com/client");
  ok("localhost:3000", "https://localhost:3000/");
  ok("http://127.0.0.1:5173", "http://127.0.0.1:5173/", true);
  ok("http://example.com", "http://example.com/", true);
  for (const bad of ["", "   ", "javascript:alert(1)", "file:///C:/x", "ftp://example.com/", "mailto:a@b.c",
    "C:\\Windows\\x.exe", "data:text/html,hi", "https://", `https://example.com/${"a".repeat(2100)}`, null, 42]) {
    const result = normalizeServiceUrl(bad);
    assert.equal(result.ok, false, String(bad).slice(0, 40));
    assert.ok(result.error, "a readable reason");
  }
});

test("same-site approximates the registrable domain", () => {
  assert.equal(isSameSite("https://mail.google.com/mail/u/0/", "https://meet.google.com"), true);
  assert.equal(isSameSite("https://teams.microsoft.com/v2/", "https://login.microsoftonline.com"), false);
  assert.equal(isSameSite("https://discord.com/app", "https://evil.example"), false);
  assert.equal(isSameSite("http://127.0.0.1:5000/", "http://127.0.0.1:6000/x"), true);
  assert.equal(isSameSite("http://127.0.0.1:5000/", "http://localhost:5000/"), false);
  assert.equal(isSameSite("http://localhost:1/", "http://localhost:2/"), true);
  assert.equal(isSameSite("https://a.example.co.uk/", "https://b.example.co.uk/"), true);
  assert.equal(isSameSite("https://alice.co.uk/", "https://bob.co.uk/"), false);
  assert.equal(isSameSite("https://alice.github.io/", "https://bob.github.io/"), false);
  assert.equal(isSameSite("https://example.com/", "http://example.com/"), false, "schemeful");
  assert.equal(isSameSite("https://example.com/", "null"), false);
  assert.equal(isSameSite("https://example.com/", "file:///C:/x"), false);
  assert.equal(isSameSite("https://[::1]:3000/", "https://[::1]:4000/"), true);
  assert.equal(siteOfHost("WWW.Example.COM."), "example.com");
});

test("sites come from the Public Suffix List, private domains included", () => {
  assert.equal(isSameSite("https://a.com.pk/", "https://b.com.pk/"), false);
  assert.equal(isSameSite("https://chat.acme.com.pk/", "https://other-company.com.pk/"), false);
  assert.equal(isSameSite("https://chat.acme.com.pk/", "https://files.acme.com.pk/"), true);
  assert.equal(isSameSite("https://x.azurestaticapps.net/", "https://y.azurestaticapps.net/"), false, "shared hosting tenants");
  assert.equal(isSameSite("https://team.myshopify.com/", "https://other.myshopify.com/"), false);
  assert.equal(isSameSite("https://teams.cloud.microsoft/", "https://outlook.cloud.microsoft/"), true);
  assert.equal(siteOfHost("chat.acme.com.pk"), "acme.com.pk");
  assert.equal(siteOfHost("s3.amazonaws.com"), "s3.amazonaws.com", "a public suffix itself is its own site");
  assert.equal(siteOfHost("127.0.0.1"), "127.0.0.1");
  assert.equal(siteOfHost("localhost"), "localhost");
  assert.equal(siteOfHost("intranet"), "intranet");
  assert.equal(siteOfHost("[::1]"), "[::1]");
});

test("service-owned URLs match the configured address or a fixed alias, never the page shown now", () => {
  const serviceUrl = "https://teams.microsoft.com/v2/";
  assert.equal(isServiceOwnedUrl({ url: "https://teams.microsoft.com", serviceUrl }), true);
  assert.equal(isServiceOwnedUrl({ url: "https://teams.cloud.microsoft", serviceUrl, aliases: ["https://teams.cloud.microsoft/"] }), true);
  assert.equal(isServiceOwnedUrl({ url: "https://teams.cloud.microsoft", serviceUrl }), false);
  assert.equal(isServiceOwnedUrl({ url: "https://ads.example", serviceUrl, aliases: ["https://teams.cloud.microsoft/"] }), false);
  assert.equal(isServiceOwnedUrl({ url: "https://ads.example", serviceUrl, topLevelUrl: "https://ads.example/" }), false,
    "the current top-level page no longer counts");
  assert.equal(isServiceOwnedUrl({ url: null, serviceUrl, aliases: [serviceUrl] }), false);
  assert.equal(isServiceOwnedUrl({ url: "https://other-company.com.pk", serviceUrl: "https://chat.acme.com.pk/" }), false);
  assert.equal(originOf("http://127.0.0.1:61136/"), "http://127.0.0.1:61136");
  assert.equal(originOf("file:///C:/x"), null);
});

test("notification frames: the service's own frames and aliases pass, an off-site page does not", () => {
  const teams = siteAliasesFor({ id: "teams", isBuiltIn: true });
  const serviceUrl = "https://teams.microsoft.com/v2/";
  const owned = (url, aliases = teams) => isServiceOwnedUrl({ url, serviceUrl, aliases });
  assert.equal(owned("https://teams.cloud.microsoft/v2/"), true, "Teams' redirect to its new domain");
  assert.equal(owned("https://teams.live.com/v2/"), true);
  assert.equal(owned("https://statics.teams.cdn.office.net/frame"), false);
  assert.equal(owned("https://unrelated.example/"), false, "a page the view moved to is not the service");
  assert.equal(owned("https://unrelated.example/", [...teams, "https://teams.cloud.microsoft/v2/"]), false);
  assert.equal(owned("https://emails.microsoft.com/frame"), true, "a same-site subframe");
  assert.equal(owned("https://landing.example/", [...teams, "https://landing.example/home"]), true, "where the home address landed");
});

test("built-in apps get fixed aliases; custom apps get none", () => {
  assert.deepEqual(siteAliasesFor({ id: "teams", isBuiltIn: true }),
    ["https://teams.microsoft.com/v2/", "https://teams.cloud.microsoft/", "https://teams.live.com/"]);
  assert.deepEqual(siteAliasesFor({ id: "messenger", isBuiltIn: true }), ["https://www.facebook.com/messages/", "https://www.messenger.com/"]);
  assert.deepEqual(siteAliasesFor({ id: "gmail", isBuiltIn: true }), ["https://mail.google.com/mail/u/0/#inbox"]);
  assert.deepEqual(siteAliasesFor({ id: "teams", isBuiltIn: false }), [], "a custom app never borrows a built-in's sites");
  assert.deepEqual(siteAliasesFor({ id: "custom", isBuiltIn: true }), []);
  assert.deepEqual(siteAliasesFor(null), []);
});

test("only this repository's GitHub release pages pass the update check", () => {
  const repo = "ZevosSky/personal-comms-hub";
  assert.equal(isGitHubReleaseUrl("https://github.com/ZevosSky/personal-comms-hub/releases/tag/v1.3.0", repo), true);
  assert.equal(isGitHubReleaseUrl("https://github.com/zevossky/Personal-Comms-Hub/releases/download/v1/x.exe", repo), true);
  for (const bad of [
    "http://github.com/ZevosSky/personal-comms-hub/releases/tag/v1",
    "https://github.com.evil.example/ZevosSky/personal-comms-hub/releases/tag/v1",
    "https://evil.example/ZevosSky/personal-comms-hub/releases/",
    "https://github.com/Other/personal-comms-hub/releases/tag/v1",
    "https://github.com/ZevosSky/personal-comms-hub-fork/releases/tag/v1",
    "https://github.com/ZevosSky/personal-comms-hub/archive/main.zip",
    "https://user:pass@github.com/ZevosSky/personal-comms-hub/releases/tag/v1",
    "file:///C:/evil.exe",
    null
  ]) {
    assert.equal(isGitHubReleaseUrl(bad, repo), false, String(bad));
  }
  assert.equal(isGitHubReleaseUrl("https://github.com/ZevosSky/personal-comms-hub/releases/tag/v1", null), false);
});

test("shell documents are the app's own files and, in dev, the dev server", () => {
  const windows = createShellDocumentMatcher({
    files: ["C:\\Users\\Gary Yang\\App\\dist\\index.html", "C:\\Users\\Gary Yang\\App\\electron\\trigger.html"],
    platform: "win32"
  });
  assert.equal(windows("file:///C:/Users/Gary%20Yang/App/dist/index.html?mode=full"), true);
  assert.equal(windows("file:///c:/users/gary%20yang/app/DIST/index.html#x"), true);
  assert.equal(windows("file:///C:/Users/Gary%20Yang/App/electron/trigger.html?corner=top-right"), true);
  assert.equal(windows("file:///C:/Users/Gary%20Yang/App/dist/other.html"), false);
  assert.equal(windows("file://server/share/dist/index.html"), false);
  assert.equal(windows("http://127.0.0.1:5000/account-a"), false);
  assert.equal(windows("http://localhost:5173/?mode=full"), false, "no dev server outside dev runs");
  assert.equal(windows("not a url"), false);

  const dev = createShellDocumentMatcher({ files: ["/app/dist/index.html"], devOrigin: "http://localhost:5173", platform: "linux" });
  assert.equal(dev("http://localhost:5173/?mode=bubble"), true);
  assert.equal(dev("http://localhost:5174/"), false);
  assert.equal(dev("file:///app/dist/index.html?mode=dock"), true);
  assert.equal(dev("file:///APP/dist/index.html"), false, "case matters off Windows");
});
