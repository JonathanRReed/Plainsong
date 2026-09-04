import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "node:url";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(configDirectory, "./src"),
      // Electron 43 exposes `electron/main`, `electron/renderer`, and
      // `electron/common` as runtime module aliases inside the Electron
      // process, but the npm package does not declare them as physical
      // subpaths. Vitest runs under Node, where Vite's import-analysis
      // cannot resolve them, so alias them back to the package entry point.
      // `vi.mock` still intercepts these specifiers before the real module
      // is loaded, so the mocks in the test files continue to work.
      "electron/main": path.resolve(configDirectory, "./node_modules/electron"),
      "electron/renderer": path.resolve(configDirectory, "./node_modules/electron"),
      "electron/common": path.resolve(configDirectory, "./node_modules/electron"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    pool: "threads",
    maxWorkers: process.env.CI ? 2 : 4,
  },
});
