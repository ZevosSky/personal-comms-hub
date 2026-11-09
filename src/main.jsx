import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { getRendererMode } from "./lib/misc.js";
import "./styles.css";

const mode = getRendererMode();
// Set before the first paint so transparent dock/trigger windows never flash a background.
document.documentElement.dataset.windowMode = mode;
document.body.dataset.windowMode = mode;

const render = () => {
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <App mode={mode} />
    </StrictMode>
  );
};

// `npx vite` in a plain browser: install a mock bridge. Dead code in production builds.
if (import.meta.env.DEV && typeof window.commsApp === "undefined") {
  import("./dev/mockBridge.js")
    .then(({ installMockBridge }) => installMockBridge(mode))
    .finally(render);
} else {
  render();
}
