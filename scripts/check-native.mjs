// Post-install sanity check: ensure better-sqlite3's native binary actually loads.
// pnpm can silently skip the dependency's build script (no binary) or a prebuild may be
// missing for this Node ABI — both surface only at first DB boot otherwise. Fail loudly here.
// Skips cleanly when the dependency isn't installed yet (e.g. early Phase 0 before the daemon
// declares it), so an empty workspace install still succeeds.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRequire = createRequire(path.join(here, '..', 'packages', 'daemon', 'package.json'));

try {
  const Database = daemonRequire('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE _probe (x INTEGER)');
  db.close();
  console.log('[check-native] better-sqlite3 OK (native binary loads)');
} catch (err) {
  const notInstalled =
    err && err.code === 'MODULE_NOT_FOUND' && /better-sqlite3/.test(String(err.message));
  if (notInstalled) {
    console.log('[check-native] better-sqlite3 not installed yet — skipping check');
    process.exit(0);
  }
  console.error(
    '[check-native] better-sqlite3 is installed but FAILED to load — likely a missing prebuilt ' +
      'binary for this Node ABI, or pnpm skipped its build script.\n' +
      '  Fix: ensure `onlyBuiltDependencies: [better-sqlite3]` in pnpm-workspace.yaml, then ' +
      'reinstall. Do not rely on source compilation.\n' +
      `  Underlying error: ${err && err.message}`,
  );
  process.exit(1);
}
