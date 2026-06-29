// Daemon entrypoint. Boot order (DECISIONS #13): ensure app dir → init logger → reuse-or-start
// guard → bind port (with fallback) → write lockfile → serve. The DB open + migrate step is
// added in the next build step (between logger init and serving).
import { DAEMON_HOST, DEFAULT_DAEMON_PORT } from '@thaloslab/shared';
import { ensureAppDir } from './config/paths';
import { isProcessAlive, readLockfile, removeLockfile, writeLockfile } from './config/lockfile';
import { listenWithFallback } from './config/port';
import { buildApp } from './server/app';
import { registerStatic } from './server/static';
import { initLogger, log } from './logger';
import { openDb } from './store/db';
import { runMigrations } from './store/migrate';
import { detectAll } from './providers/registry';
import { createRuntime } from './workflow/runtime';
import { recoverInFlight } from './workflow/recovery';
import { registerWebSocket } from './server/ws';

const VERSION = '0.0.0';

async function main(): Promise<void> {
  ensureAppDir();
  initLogger();

  // Idempotency guard: never start a second instance over a live one. (The CLI does the
  // health-ping reuse decision; this is the daemon-side backstop.)
  const existing = readLockfile();
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    log(
      'warn',
      `daemon already running (pid ${existing.pid}, port ${existing.port}); not starting again`,
    );
    process.stdout.write(`${JSON.stringify({ reused: true, ...existing })}\n`);
    return;
  }
  if (existing) {
    log('info', `cleaning up stale lockfile (pid ${existing.pid} not alive)`);
  }

  // Open the global DB and apply migrations before serving (DECISIONS #14).
  const db = openDb();
  runMigrations(db);
  log('info', 'database ready (migrations applied)');

  // Detect installed providers (zero token spend) and populate the providers table.
  const detected = await detectAll();
  log('info', `provider detection: ${detected.map((p) => `${p.id}=${p.installed}`).join(', ')}`);

  // Workflow engine runtime + crash recovery (reconcile in-flight tickets against disk).
  const runtime = createRuntime();
  const recovered = await recoverInFlight(runtime.engine);
  if (recovered.length > 0) log('info', `recovered ${recovered.length} in-flight ticket(s)`);

  const startedAt = Date.now();
  let boundPort = DEFAULT_DAEMON_PORT;

  const app = buildApp({
    health: { version: VERSION, startedAt, getPort: () => boundPort },
    runtime,
  });
  await registerWebSocket(app, runtime);
  const servingUi = await registerStatic(app);
  log('info', servingUi ? 'serving bundled web UI' : 'no bundled UI (dev: Vite serves it)');

  boundPort = await listenWithFallback(app, DEFAULT_DAEMON_PORT, DAEMON_HOST);
  writeLockfile({ pid: process.pid, port: boundPort, startedAt });
  log('info', `daemon listening on http://${DAEMON_HOST}:${boundPort} (pid ${process.pid})`);
  // Machine-readable ready line for the CLI launcher.
  process.stdout.write(`${JSON.stringify({ ready: true, port: boundPort, pid: process.pid })}\n`);

  const shutdown = async (sig: string): Promise<void> => {
    log('info', `received ${sig}, shutting down`);
    try {
      await app.close();
    } finally {
      removeLockfile();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err: unknown) => {
  log('error', `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
