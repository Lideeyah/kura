import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The end-to-end suite spawns a real MCP peer over stdio and drives real timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The ledger is a single SQLite file with a strict hash chain; parallel files
    // would interleave appends and make sequence assertions meaningless.
    fileParallelism: false,
  },
});
