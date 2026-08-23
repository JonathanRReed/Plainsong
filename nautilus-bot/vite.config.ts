import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "node:url";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(configDirectory, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/rust-sidecar/**"],
    },
  },
  envPrefix: ["VITE_"],
  build: {
    target: "chrome120",
    minify: "esbuild" as const,
    sourcemap: false,
    outDir: "dist",
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
}));
