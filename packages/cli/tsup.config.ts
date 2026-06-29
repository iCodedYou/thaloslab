import { defineConfig } from 'tsup';

// Bundles the thaloslab bin to ESM with an executable shebang. @thaloslab/shared is inlined; the
// daemon is NOT bundled (resolved + spawned at runtime via createRequire). better-sqlite3 is kept
// external defensively in case it appears transitively.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  external: ['better-sqlite3'],
  noExternal: [/^@thaloslab\/shared/],
  banner: { js: '#!/usr/bin/env node' },
});
