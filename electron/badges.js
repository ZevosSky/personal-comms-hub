// Unread counts read from service page titles (D4, D5) and the taskbar overlay badge.
// Electron-free so the title formats can be unit-tested.
import { parseUrl } from "./urlPolicy.js";

const MAX_COUNT = 99999;

const toCount = (digits) => {
  const number = Number(String(digits).replace(/[^\d]/g, ""));
  return Number.isFinite(number) ? Math.min(number, MAX_COUNT) : null;
};

// "(3) Discord | #general", "[12] Chat", "(99+) Messenger"
const leadingCount = /^\s*[([]\s*(\d[\d.,\s]*)\+?\s*[)\]]/;
// Titles some apps flash while a message is waiting; they say nothing about the count.
const transientTitle = /\bmessaged you\b|\bsent (?:you )?an? \w+|\bis calling\b|\bcalling you\b|\bnew messages?\b|\bwants to\b/i;

// Gmail: "<label> (n) - <account> - Gmail", or "<label> - <account> - Gmail" when nothing is
// unread. Other pages (a thread, another label) have no count, so only the inbox is trusted.
const gmailInboxLabels = new Set([
  "inbox", "primary", "posteingang", "boîte de réception", "recibidos", "bandeja de entrada",
  "posta in arrivo", "caixa de entrada", "postvak in", "inkorgen", "indbakke", "innboks",
  "saapuneet", "odebrane", "doručená pošta", "входящие", "受信トレイ", "收件箱", "받은편지함"
]);
const gmailLabelCount = /^(.+?)\s*\((\d[\d.,\s]*)\)$/;
const parseGmail = (title) => {
  const label = title.split(" - ")[0].trim();
  const counted = label.match(gmailLabelCount);
  if (counted) return gmailInboxLabels.has(counted[1].trim().toLowerCase()) ? toCount(counted[2]) : null;
  return gmailInboxLabels.has(label.toLowerCase()) ? 0 : null;
};

// Discord, Messenger, Teams, WhatsApp and most chat apps prefix the title with the count and drop
// the prefix when everything is read.
const parseLeading = (title) => {
  const match = title.match(leadingCount);
  if (match) return toCount(match[1]);
  return transientTitle.test(title) ? null : 0;
};

// "[2026] Roadmap", "(2024) Annual review": a bracketed year, not an unread count.
const looksLikeYear = (match) => {
  const digits = match[1].trim();
  return !match[0].includes("+") && /^\d{4}$/.test(digits) && Number(digits) >= 1900 && Number(digits) <= 2100;
};

const parseGeneric = (title) => {
  const leading = title.match(leadingCount);
  if (leading && !looksLikeYear(leading)) return toCount(leading[1]);
  const inbox = title.match(/^\s*inbox\s*\((\d[\d.,\s]*)\)/i);
  if (inbox) return toCount(inbox[1]);
  return transientTitle.test(title) ? null : 0;
};

const hostOf = (service) => parseUrl(service?.url)?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
const isHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** "gmail" | "leading" | "none" | "generic": how the service's page title carries its count. */
export const titleFormatFor = (service) => {
  const host = hostOf(service);
  if (host === "mail.google.com" || (!host && service?.id === "gmail")) return "gmail";
  // Slack titles carry no number at all.
  if (isHost(host, "slack.com") || (!host && service?.id === "slack")) return "none";
  if (isHost(host, "discord.com") || isHost(host, "facebook.com") || isHost(host, "messenger.com") ||
      isHost(host, "teams.microsoft.com") || isHost(host, "teams.live.com") || isHost(host, "teams.cloud.microsoft") ||
      isHost(host, "whatsapp.com")) return "leading";
  return "generic";
};

/**
 * The unread count in a page title: a number, or null when the title says nothing either way
 * (the previous count should then be kept).
 */
export const parseBadgeCount = (title, service = {}) => {
  const value = String(title ?? "").trim();
  if (!value) return null;
  switch (titleFormatFor(service)) {
    case "gmail": return parseGmail(value);
    case "none": return null;
    case "leading": return parseLeading(value);
    default: return parseGeneric(value);
  }
};

export const badgesEnabledFor = (service) =>
  Boolean(service?.isEnabled && service.supportsBadgeDetection !== false && service.notificationSettings?.badgeEnabled !== false);

/**
 * `runtime.badgeCounts`: each service's title count while the page that reported it is still
 * loaded, else 0 (asleep, unknown, or badges turned off).
 * `titleCounts` is a Map of serviceId -> { count, webContentsId }.
 */
export const badgeCountsFor = ({ services = [], runtimeServices = {}, titleCounts = new Map() }) => {
  const counts = {};
  for (const service of services) {
    const stored = titleCounts.get(service.id);
    const current = runtimeServices[service.id]?.webContentsId ?? null;
    counts[service.id] = badgesEnabledFor(service) && stored && current !== null && stored.webContentsId === current
      ? stored.count
      : 0;
  }
  return counts;
};

export const OVERLAY_BADGE_MAX_BYTES = 64 * 1024;
const pngDataUrl = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validates `app:set-overlay-badge` input: `{ count, dataUrl }` with a PNG data URL of at most
 * 64 KB, or a null dataUrl (or zero count) to clear. Returns null for anything else.
 */
export const parseOverlayBadge = (payload) => {
  if (payload === null) return { count: 0, dataUrl: null };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const count = Number(payload.count ?? 0);
  if (!Number.isFinite(count) || count < 0) return null;
  const total = Math.min(MAX_COUNT, Math.floor(count));
  const { dataUrl } = payload;
  if (dataUrl === null || dataUrl === undefined || total === 0) return { count: total, dataUrl: null };
  if (typeof dataUrl !== "string" || dataUrl.length > OVERLAY_BADGE_MAX_BYTES || !pngDataUrl.test(dataUrl)) return null;
  return { count: total, dataUrl };
};

export const overlayDescription = (count) => (count > 0 ? `${count > 999 ? "999+" : count} unread` : "");
