// thaloslab launcher (SPEC §13). Flags skip the menu; otherwise an interactive menu picks the
// mode. Boots (or reuses) the daemon, reports the provider pool, and opens the browser UI.
import { Command } from 'commander';
import * as p from '@clack/prompts';
import type { ExecutionMode } from '@thaloslab/shared';
import { runMenu } from './menu';
import { DaemonStartError, launchDaemon } from './launch';
import { fetchProviders, formatProviders } from './detect-report';
import { openUi } from './open-ui';

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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
