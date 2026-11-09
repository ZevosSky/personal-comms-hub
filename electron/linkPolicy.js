// External link policy (D14). Every shell.openExternal call goes through createExternalOpener.
// Electron-free: shell and dialog are injected so the rules can be unit-tested.

export const EXTERNAL_URL_MAX_LENGTH = 8192;

const directSchemes = new Set(["https:", "http:", "mailto:", "tel:"]);

// Known app deep links open only after a confirm that shows the URL. The ms-* allow list is the
// Office "open in desktop app" schemes used by Teams and SharePoint.
const deepLinkApps = new Map([
  ["msteams:", "Microsoft Teams"],
  ["slack:", "Slack"],
  ["discord:", "Discord"],
  ["zoommtg:", "Zoom"],
  ["zoomus:", "Zoom"],
  ["tg:", "Telegram"],
  ["whatsapp:", "WhatsApp"],
  ["skype:", "Skype"],
  ["webcal:", "your calendar app"],
  ["spotify:", "Spotify"],
  ["ms-word:", "Microsoft Word"],
  ["ms-excel:", "Microsoft Excel"],
  ["ms-powerpoint:", "Microsoft PowerPoint"]
]);

// Never handed to the OS: local files, script/data URLs, Windows search and diagnostics handlers,
// and other schemes known to run or fetch local content.
const blockedSchemes = new Set([
  "file:", "javascript:", "data:", "vbscript:", "blob:", "about:", "smb:", "search-ms:", "search:",
  "ms-msdt:", "ms-officecmd:", "shell:", "hcp:", "its:", "mk:", "mhtml:", "res:", "jar:",
  "view-source:", "filesystem:", "chrome:", "chrome-extension:", "devtools:"
]);

const block = (url, scheme, reason) => ({ action: "block", url, scheme, reason, appName: null });

/**
 * Classifies a URL a page or the app wants to open outside Comms Hub.
 * Returns { action: "open" | "confirm" | "block", url, scheme, reason, appName }, where url is the
 * normalized href to hand to the OS (never the raw input).
 */
export const classifyExternalUrl = (raw) => {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input || input.length > EXTERNAL_URL_MAX_LENGTH) return block(null, null, "invalid");
  if (/^(?:\\\\|\/\/)/.test(input)) return block(null, null, "unc-path");

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return block(null, null, "invalid");
  }

  const scheme = parsed.protocol.toLowerCase();
  const url = parsed.href;
  // "C:\..." parses with a one-letter scheme; that is a local path, not a link.
  if (scheme.length <= 2) return block(url, scheme, "local-path");
  if (blockedSchemes.has(scheme) || scheme.startsWith("ms-cxh")) return block(url, scheme, "blocked-scheme");
  if (deepLinkApps.has(scheme)) {
    return { action: "confirm", url, scheme, reason: "app-link", appName: deepLinkApps.get(scheme) };
  }
  if (scheme.startsWith("ms-")) return block(url, scheme, "blocked-scheme");
  if (directSchemes.has(scheme)) {
    if ((scheme === "https:" || scheme === "http:") && !parsed.hostname) return block(url, scheme, "invalid");
    return { action: "open", url, scheme, reason: "web", appName: null };
  }
  return { action: "confirm", url, scheme, reason: "unknown-scheme", appName: null };
};

/** Sliding-window limiter keyed by source (a webContents id, "shell", "updates", ...). */
export const createRateLimiter = ({ count, windowMs, now = Date.now }) => {
  const hits = new Map();
  return (key) => {
    const time = now();
    const recent = (hits.get(key) ?? []).filter((at) => time - at < windowMs);
    if (hits.size > 200) {
      for (const [other, stamps] of hits) {
        if (!stamps.some((at) => time - at < windowMs)) hits.delete(other);
      }
    }
    if (recent.length >= count) {
      hits.set(key, recent);
      return false;
    }
    recent.push(time);
    hits.set(key, recent);
    return true;
  };
};

/**
 * open(raw, { source, ...context }) resolves to "opened" | "cancelled" | "blocked" | "dropped" |
 * "failed". Only one confirm prompt is shown at a time and each source gets a small prompt and
 * open budget, so a page looping window.open cannot storm the user.
 */
export function createExternalOpener({
  openExternal,
  confirm,
  onBlocked = () => {},
  onDropped = () => {},
  log = () => {},
  now = Date.now,
  openLimit = { count: 3, windowMs: 5000 },
  promptLimit = { count: 3, windowMs: 60000 }
}) {
  const takeOpen = createRateLimiter({ ...openLimit, now });
  const takePrompt = createRateLimiter({ ...promptLimit, now });
  let promptOpen = false;

  const open = async (raw, context = {}) => {
    const source = context.source ?? "app";
    const verdict = classifyExternalUrl(raw);
    if (verdict.action === "block") {
      onBlocked(verdict, context);
      return "blocked";
    }

    if (verdict.action === "confirm") {
      if (promptOpen || !takePrompt(source)) {
        onDropped(verdict, context);
        return "dropped";
      }
      promptOpen = true;
      try {
        if ((await confirm(verdict, context)) !== true) return "cancelled";
      } catch (error) {
        log("Failed to ask before opening an external link.", error);
        return "cancelled";
      } finally {
        promptOpen = false;
      }
    } else if (!takeOpen(source)) {
      onDropped(verdict, context);
      return "dropped";
    }

    try {
      await openExternal(verdict.url);
      return "opened";
    } catch (error) {
      log(`Failed to open an external ${verdict.scheme} link.`, error);
      return "failed";
    }
  };

  return { open };
}
