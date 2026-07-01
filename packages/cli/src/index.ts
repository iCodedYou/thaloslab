// thaloslab launcher (SPEC §13). Flags skip the menu; otherwise an interactive menu picks the
// mode. Boots (or reuses) the daemon, reports the provider pool, and opens the browser UI.
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import type { ExecutionMode } from '@thaloslab/shared';
import { runMenu } from './menu';
import { DaemonStartError, launchDaemon } from './launch';
import { fetchProviders, formatProviders } from './detect-report';
import { openUi } from './open-ui';
import { resolvePeerLaunch } from './peer-locate';

interface CliFlags {
  live?: boolean;
  mock?: boolean;
  collab?: boolean;
  menu?: boolean; // --no-menu => false
  open?: boolean; // --no-open => false
}

async function run(flags: CliFlags): Promise<void> {
  let mode: ExecutionMode = flags.live ? 'live' : flags.mock ? 'mock' : 'preview';
  let collab = Boolean(flags.collab);

  const flagsProvided = Boolean(flags.live || flags.mock || flags.collab);
  if (flags.menu !== false && !flagsProvided) {
    const choices = await runMenu({ mode, collab });
    if (!choices) return;
    mode = choices.mode;
    collab = choices.collab;
  }

  const spin = p.spinner();
  spin.start('Starting Thalos daemon');
  try {
    const result = await launchDaemon(mode);
    spin.stop(result.reused ? `Reusing daemon at ${result.url}` : `Daemon ready at ${result.url}`);

    const providers = await fetchProviders(result.port);
    p.log.info(`Providers: ${formatProviders(providers)}`);
    if (collab) p.log.info('Collab pooling: enabled');

    if (flags.open === false) {
      p.outro(result.url);
    } else {
      await openUi(result.url);
      p.outro(`Opened ${result.url}`);
    }
  } catch (err) {
    spin.stop('Failed to start daemon');
    p.log.error(err instanceof DaemonStartError ? err.message : String(err));
    process.exitCode = 1;
  }
}

/** Run this machine as a collab PEER: spawn the DB-less peer-agent bundle as its own process (never
 *  in-process — that would drag the CLI into the peer's runtime), forwarding flags; env vars
 *  (THALOS_COLLAB_HOST/TOKEN, THALOS_PEER_ID) are inherited and resolved by the peer itself. */
function runPeer(opts: { host?: string; token?: string; peerId?: string; cwd?: string }): void {
  const launch = resolvePeerLaunch();
  const forwarded: string[] = [];
  if (opts.host) forwarded.push('--host', opts.host);
  if (opts.token) forwarded.push('--token', opts.token);
  if (opts.peerId) forwarded.push('--peer-id', opts.peerId);
  if (opts.cwd) forwarded.push('--cwd', opts.cwd);
  const child = spawn(launch.command, [...launch.args, ...forwarded], {
    cwd: launch.cwd,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}

const program = new Command();
program
  .name('thaloslab')
  .description('Local orchestration of installed AI coding CLIs as a role-based engineering team')
  .version('0.0.0')
  .option('--live', 'real provider invocation and repo writes')
  .option('--mock', 'dev-only: fully stubbed providers, zero token spend')
  .option('--collab', 'enable collab pooling')
  .option('--no-menu', 'skip the interactive menu')
  .option('--no-open', 'do not open the browser')
  .action((opts: CliFlags) => run(opts));

program
  .command('peer')
  .description(
    'run this machine as a collab peer-agent: dial a host, self-test the sandbox, serve invokes',
  )
  .option(
    '--host <url>',
    'host collab endpoint, e.g. ws://100.x.x.x:8474 (or env THALOS_COLLAB_HOST)',
  )
  .option('--token <token>', 'one-time join token issued by the host (or env THALOS_COLLAB_TOKEN)')
  .option('--peer-id <id>', 'this peer’s id (or env THALOS_PEER_ID)')
  .option('--cwd <dir>', 'scratch worktree dir for invokes (default: a temp dir)')
  .action((opts: { host?: string; token?: string; peerId?: string; cwd?: string }) =>
    runPeer(opts),
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
