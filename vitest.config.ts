import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(projectRoot, "web"),
    },
  },
  test: {
    coverage: {
      reporter: ["text", "html"],
    },
    environment: "node",
    include: ["src/**/*.test.ts", "web/**/*.test.tsx"],
  },
});
