import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

// Bundles the daemon to ESM. better-sqlite3 is a NATIVE addon and MUST stay external (bundling a
// .node breaks it). @thaloslab/shared is inlined. The createRequire banner lets any transitive
// CJS `require` work from the ESM bundle. Migrations (.sql) are data — copied next to the bundle
// since tsup won't bundle them; the web SPA build is copied into dist/public when present.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  external: ['better-sqlite3'],
  noExternal: [/^@thaloslab\/shared/],
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  onSuccess: () => {
    const dist = path.resolve('dist');
    cpSync(path.resolve('migrations'), path.join(dist, 'migrations'), { recursive: true });
    // Copy the built web SPA if it exists (produced by `pnpm --filter @thaloslab/web build`).
    const webDist = path.resolve('..', 'web', 'dist');
    const publicDir = path.join(dist, 'public');
    if (existsSync(publicDir)) rmSync(publicDir, { recursive: true, force: true });
    if (existsSync(webDist)) cpSync(webDist, publicDir, { recursive: true });
    return Promise.resolve();
  },
});
