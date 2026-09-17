import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer/src"), "@shared": resolve(import.meta.dirname, "src/shared") } },
  test: { include: ["tests/**/*.test.{ts,tsx}"], exclude: ["tests/e2e/**"] },
});
