import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the dev build from a fixed port and needs a stable one.
// `base: "./"` matters for the desktop bundle and for Flask serving the built
// files: both load the app from somewhere other than a server root.
//
// In dev the page calls its own origin and Vite forwards /v1 to the service, so
// the same dev server works from this machine and from a phone on the tailnet.
// FLYSCAN_API moves the service; FLYSCAN_DEV_HOST is the name the
// page is opened by from elsewhere (Vite refuses hosts it was not told about).
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    allowedHosts: process.env.FLYSCAN_DEV_HOST ? [process.env.FLYSCAN_DEV_HOST] : [],
    proxy: { "/v1": process.env.FLYSCAN_API ?? "http://127.0.0.1:5111" },
  },
  build: { target: "es2022", outDir: "dist" },
});
