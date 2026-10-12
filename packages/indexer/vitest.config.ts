import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The embedded database takes a few seconds to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
