// URL rules shared by the main process: service addresses, same-site checks, shell documents and
// release links. Electron-free so the rules can be unit-tested.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDomain } from "tldts";

export const SERVICE_URL_MAX_LENGTH = 2048;

export const parseUrl = (value) => {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isWebUrl = (parsed) => Boolean(parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname);

/** The serialized origin of an http(s) URL or origin string, else null. */
export const originOf = (value) => {
  const parsed = parseUrl(value);
  return isWebUrl(parsed) ? parsed.origin : null;
};

const hasAuthority = /^[a-z][a-z0-9+.-]*:\/\//i;
// "localhost:3000" is a host and port, not a scheme.
const schemeWithoutPort = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

/**
 * Validates an address typed for a service. Bare hosts get https://. Plain http is accepted
 * (the renderer warns about it); every other scheme is refused.
 * Returns { ok, url, insecure, error }.
 */
export const normalizeServiceUrl = (input) => {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return { ok: false, url: null, insecure: false, error: "Enter the app's web address." };
  if (trimmed.length > SERVICE_URL_MAX_LENGTH) {
    return { ok: false, url: null, insecure: false, error: "That web address is too long." };
  }
  const candidate = hasAuthority.test(trimmed) || schemeWithoutPort.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = parseUrl(candidate);
  if (!parsed) return { ok: false, url: null, insecure: false, error: "That doesn't look like a web address." };
  if (!isWebUrl(parsed)) {
    return { ok: false, url: null, insecure: false, error: "App addresses must start with https:// (or http://)." };
  }
  return { ok: true, url: parsed.href, insecure: parsed.protocol === "http:", error: null };
};

const isIpAddress = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");

/**
 * IPs, localhost and single-label hosts are their own site; otherwise the registrable domain from
 * the Public Suffix List, private domains included (other tenants of a shared host such as
 * *.github.io or *.azurestaticapps.net are other sites). A host that is itself a public suffix
 * is its own site.
 */
export const siteOfHost = (hostname) => {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (!host || isIpAddress(host) || !host.includes(".")) return host;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
};

/** Schemeful same-site (scheme + registrable domain; ports ignored). Opaque origins never match. */
export const isSameSite = (left, right) => {
  const a = parseUrl(left);
  const b = parseUrl(right);
  if (!isWebUrl(a) || !isWebUrl(b) || a.protocol !== b.protocol) return false;
  return siteOfHost(a.hostname) === siteOfHost(b.hostname);
};

/**
 * True when a frame or requesting origin belongs to the service: same-site with the service's
 * configured URL or one of its fixed aliases (a built-in app's other sites, the page its home
 * address landed on). Whatever page the view shows right now never counts by itself.
 */
export const isServiceOwnedUrl = ({ url, serviceUrl, aliases = [] }) =>
  isSameSite(url, serviceUrl) || (Array.isArray(aliases) && aliases.some((alias) => isSameSite(url, alias)));

/** Only https://github.com/<owner>/<repo>/releases/... is opened from the update check. */
export const isGitHubReleaseUrl = (value, repository) => {
  const parsed = parseUrl(value);
  if (!parsed || !repository || parsed.protocol !== "https:" || parsed.hostname !== "github.com") return false;
  if (parsed.username || parsed.password || parsed.port) return false;
  return parsed.pathname.toLowerCase().startsWith(`/${String(repository).toLowerCase()}/releases/`);
};

/**
 * Builds the test for "this URL is one of the app's own shell documents": the given local files
 * (any query or hash) and, in dev runs, the Vite dev server origin.
 */
export const createShellDocumentMatcher = ({ files = [], devOrigin = null, platform = process.platform }) => {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const normalize = (filePath) => {
    const resolved = pathApi.resolve(filePath);
    return windows ? resolved.toLowerCase() : resolved;
  };
  const allowedFiles = new Set(files.map(normalize));
  return (value) => {
    const parsed = parseUrl(value);
    if (!parsed) return false;
    if (parsed.protocol === "file:") {
      if (parsed.host) return false;
      try {
        return allowedFiles.has(normalize(fileURLToPath(`file://${parsed.pathname}`, { windows })));
      } catch {
        return false;
      }
    }
    return Boolean(devOrigin) && parsed.origin === devOrigin;
  };
};
