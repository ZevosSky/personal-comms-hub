export const getRendererMode = (search = typeof window === "undefined" ? "" : window.location.search) => {
  const mode = new URLSearchParams(search).get("mode");
  // "trigger" may no longer be loaded by main; it stays a harmless, tiny view.
  return mode === "dock" || mode === "bubble" || mode === "trigger" ? mode : "full";
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const getFocusable = (root) =>
  root
    ? Array.from(root.querySelectorAll(FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0 && !element.closest("[inert]")
      )
    : [];

// 32x32 PNG for the Windows taskbar overlay: red circle with a white count ("9+" above 9).
export const renderOverlayBadge = (count) => {
  if (!count || typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#e11d48";
    context.beginPath();
    context.arc(16, 16, 15.5, 0, Math.PI * 2);
    context.fill();
    const label = count > 9 ? "9+" : String(count);
    context.fillStyle = "#ffffff";
    context.font = `bold ${label.length > 1 ? 17 : 21}px "Segoe UI", Arial, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, 16, 17);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
};
