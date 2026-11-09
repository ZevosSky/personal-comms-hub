import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Strict CSP for the packaged shell (loaded from file://). Build-only: the dev server needs
// inline scripts (React refresh preamble) and a websocket for HMR.
// img-src: data: for built-in SVG icons and screen-share thumbnails, file: for uploaded icons.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: file:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

const injectContentSecurityPolicy = () => ({
  name: "comms-hub-csp",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy },
        injectTo: "head-prepend"
      }
    ]
  }
});

export default defineConfig({
  base: "./",
  plugins: [react(), injectContentSecurityPolicy()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist"
  }
});
