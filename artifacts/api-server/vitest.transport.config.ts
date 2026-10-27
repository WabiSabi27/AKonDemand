import { defineConfig } from "vitest/config";

// Intentionally no shared setup: transport fixtures must not import the app,
// resolve payment credentials, or access the shared database.
export default defineConfig({
  test: {
    include: ["tests/transport/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 10_000,
  },
});
