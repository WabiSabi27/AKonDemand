import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/transport/**"],
    environment: "node",
    globals: false,
    setupFiles: ["tests/setup.ts"],
    // Single fork — every test writes to the shared dev/CI Postgres. Parallel
    // workers would race on the prefix-cleanup pass and on Stripe-init side
    // effects from importing `app.ts`.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
