import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve("electron/main/index.ts") } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve("electron/preload/index.ts"), output: { format: "cjs", entryFileNames: "[name].js" } } },
  },
  renderer: {
    root: "src/renderer",
    resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
    plugins: [react()],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
