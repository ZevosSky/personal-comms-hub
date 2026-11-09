// Renderer script for trigger.html (the collapsed dock tab). Runs in the page, not in Node.
(() => {
  const corner = new URLSearchParams(window.location.search).get("corner") || "bottom-left";
  const rightAnchored = corner === "top-right" || corner === "bottom-right";
  document.body.className = rightAnchored ? "right-anchored" : "left-anchored";
  document.getElementById("open-dock").addEventListener("click", () => {
    window.commsApp?.openDockFromTrigger().catch(() => {});
  });
})();
