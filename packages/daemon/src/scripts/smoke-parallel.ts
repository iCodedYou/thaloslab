// --live parallel-feature smoke (run manually; spends tokens). Exercises the REAL agent path once:
// the architect emits a multi-lane decomposition, ≥2 engineers build in isolated lane worktrees,
// the integrator merges into thalos/integration, and the default branch is NEVER touched.
//
// Run:  pnpm --filter @thaloslab/daemon exec tsx src/scripts/smoke-parallel.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '../../../../fixtures/feature-sample');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-smoke-feature-'));
process.env.THALOS_DB_PATH = path.join(repo, 'smoke.db');

const { openDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { getTicket } = await import('../store/repositories/tickets');
const { listTasksByTicket } = await import('../store/repositories/tasks');
const { listGatesByTicket } = await import('../store/repositories/gates');
const { createRuntime } = await import('../workflow/runtime');
const { intakeTicket } = await import('../workflow/orchestrator/intake');

const TERMINAL = new Set(['done', 'failed', 'escalated', 'aborted', 'preview-complete']);

function log(...a: unknown[]): void {
  console.log('[smoke]', ...a);
}

async function main(): Promise<void> {
  // 1. Materialize the clean-seam fixture as a real git repo.
  fs.cpSync(fixture, repo, { recursive: true });
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 'smoke@localhost', false, 'local');
  await git.addConfig('user.name', 'Smoke', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\nsmoke.db*\n');
  await git.add('.');
  await git.commit('init feature-sample');
  const mainHeadBefore = (await git.revparse(['main'])).trim();
  log('repo', repo, 'main@', mainHeadBefore.slice(0, 8));

  runMigrations(openDb());
  insertProject({
    id: 'p-smoke',
    name: 'feature-sample',
    repoPath: repo,
    origin: 'scratch',
    phase: 'maintenance',
    orchestratorProvider: 'claude',
    createdAt: Date.now(),
  });

  const runtime = createRuntime();

  // 2. Intake a feature whose work splits cleanly across the two independent modules.
  log('intake (live) — architect will design + decompose…');
  const ticket = await intakeTicket(runtime.engine, {
    projectId: 'p-smoke',
    title: 'Add a feature: uppercase greeting formatter and a timestamped logging helper',
    body: 'Add an `uppercase(name)` formatter to the greeting module (src/greeting.mjs) and a `timestamped(message)` helper to the logging module (src/logging.mjs). These two modules are INDEPENDENT — decompose the work along that seam (one lane per module).',
    mode: 'live',
  });
  const id = ticket.id;

  // 3. Drive the human plan sign-off, then let the engineers + integrator run (all live).
  for (let i = 0; i < 8; i++) {
    const t = getTicket(id);
    if (!t || TERMINAL.has(t.status)) break;
    if (t.status === 'blocked') {
      const gate = listGatesByTicket(id).find((g) => g.status === 'pending');
      if (!gate) break;
      log(`approving gate "${gate.title}" → build proceeds`);
      await runtime.engine.resolveHumanGate(gate.id, 'approve', 'smoke');
    } else {
      await runtime.engine.advance(id);
    }
  }

  // 4. Report the real-agent observations.
  const finalTicket = getTicket(id);
  const tasks = listTasksByTicket(id);
  const decompPath = path.join(repo, '.thalos', 'artifacts', id, 'decomposition.json');
  const decomposition = fs.existsSync(decompPath)
    ? (JSON.parse(fs.readFileSync(decompPath, 'utf8')) as Array<{ seamPaths: string[] }>)
    : null;
  const worktrees = (() => {
    try {
      return fs
        .readdirSync(path.join(repo, '.thalos', 'worktrees'))
        .filter((d) => d.includes('seam'));
    } catch {
      return [];
    }
  })();
  const branches = (await git.branch()).all.filter((b) => b.startsWith('thalos/'));
  const integrationLog = (await git.raw(['log', '--oneline', 'thalos/integration'])).trim();
  const mainHeadAfter = (await git.revparse(['main'])).trim();

  console.log('\n========== PARALLEL-FEATURE LIVE SMOKE REPORT ==========');
  console.log('ticket status     :', finalTicket?.status);
  console.log('decomposition     :', decomposition ? `${decomposition.length} lane(s)` : 'MISSING');
  decomposition?.forEach((d, i) => console.log(`  lane ${i}: ${d.seamPaths.join(', ')}`));
  console.log('lane worktrees    :', worktrees.length, worktrees.join(', '));
  console.log('thalos/ branches  :', branches.join(', '));
  console.log('integration log   :\n' + integrationLog.replace(/^/gm, '    '));
  console.log('tasks             :');
  for (const t of tasks)
    console.log(`    ${t.stageId.padEnd(12)} ${t.laneId.padEnd(18)} ${t.state}`);
  console.log(
    'default branch    :',
    mainHeadBefore === mainHeadAfter ? 'UNCHANGED ✓ (never landed)' : 'CHANGED ✗',
  );
  console.log('repo (inspect)    :', repo);
  console.log('========================================================\n');
}

await main();
