import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(projectRoot, "web"),
    },
  },
  root: "web",
  build: {
    emptyOutDir: false,
    outDir: path.join(projectRoot, "dist/public"),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:43110",
      "/mcp": "http://127.0.0.1:43110",
    },
  },
});
