import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.tsbuild/**'],
    // Real git + real-socket integration tests (collab wire, worktrees) run in ~1–5s in isolation but can
    // spike past vitest's 5s default under full-gate parallel load on Windows. Give un-budgeted tests
    // headroom; genuinely long tests still set their own (larger) explicit timeouts, which override this.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
