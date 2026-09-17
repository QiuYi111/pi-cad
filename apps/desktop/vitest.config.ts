import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Mirror the renderer aliases from electron.vite.config.ts so tests can import
// renderer modules that use `@shared/*` / `@/*` at runtime, not just as types.
export default defineConfig({
  resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
  test: { include: ["tests/**/*.test.{ts,tsx}"], exclude: ["tests/e2e/**"] },
});
