import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000, // argon2id at 64 MiB x3 is slow on small CI runners
    hookTimeout: 120_000,
    fileParallelism: true,
  },
});
