// Pure validation for the Add/Edit app form.

const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEME_WITHOUT_PORT = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

export const NAME_MAX_LENGTH = 80;

// Returns { url, error, warning }. Bare hosts ("outlook.com", "localhost:3000") get https://.
export const normalizeServiceUrl = (input) => {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return { url: null, error: "Enter the app's web address.", warning: null };

  const candidate =
    HAS_AUTHORITY.test(trimmed) || SCHEME_WITHOUT_PORT.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { url: null, error: "That doesn't look like a web address.", warning: null };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: null, error: "Only http:// and https:// addresses are supported.", warning: null };
  }

  const host = parsed.hostname;
  if (!host) return { url: null, error: "Enter the app's web address.", warning: null };

  // Single-label hosts (http://nas:5000/) are valid on a local network and main accepts them,
  // but a typo like "outlook" looks the same, so warn instead of refusing.
  const singleLabel = !host.includes(".") && !host.includes(":") && host !== "localhost";
  const warnings = [
    singleLabel ? "This looks like a local network name. Make sure the address is right." : null,
    parsed.protocol === "http:" ? "This address isn't encrypted (http://). Use https:// if the app supports it." : null
  ].filter(Boolean);

  return { url: parsed.toString(), error: null, warning: warnings.join(" ") || null };
};

export const validateServiceForm = (form) => {
  const name = String(form?.name ?? "").trim();
  const nameError = !name
    ? "Give the app a name."
    : name.length > NAME_MAX_LENGTH
      ? `Keep the name under ${NAME_MAX_LENGTH} characters.`
      : null;
  const { url, error: urlError, warning: urlWarning } = normalizeServiceUrl(form?.url);
  return {
    name,
    url,
    errors: { name: nameError, url: urlError },
    warnings: { url: urlWarning },
    valid: !nameError && !urlError
  };
};
