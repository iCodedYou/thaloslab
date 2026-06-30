// Capped REAL two-vendor round-trip (DEFERRED-PENDING-INSTALL). Verification harness only — no engine
// logic. A tiny bugfix where the BUILDER and the adversarial REVIEWER are DIFFERENT real vendors: the
// router routes the engineer → claude (codex can't enforce the per-command allowlist) and the reviewer →
// codex (must differ from the engineer's vendor). Confirms reviewer-differs-by-vendor with a REAL codex
// in the mix. Capped + auto-abort: ≤8 invokes / ≤150k tok / ≤12 min. Needs codex ON PATH.
//   THALOS_SMOKE_MODE=live pnpm --filter @thaloslab/daemon exec tsx src/scripts/smoke-xvendor.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

const CAPS = { tokens: 150_000, wallMs: 12 * 60_000, invocations: 8 };
const start = Date.now();
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-xv-'));
process.env.THALOS_DB_PATH = path.join(repo, 'smoke.db');

const { openDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { getTicket, setTicketStatus } = await import('../store/repositories/tickets');
const { listTasksByTicket } = await import('../store/repositories/tasks');
const { listGatesByTicket } = await import('../store/repositories/gates');
const { recentRunsForTask } = await import('../store/repositories/runs');
const { detectAll } = await import('../providers/registry');
const { scaffoldThalos } = await import('../store/thalos-layout');
const { createRuntime } = await import('../workflow/runtime');
const { intakeTicket } = await import('../workflow/orchestrator/intake');

const TERMINAL = new Set(['done', 'failed', 'escalated', 'aborted', 'preview-complete']);
const log = (...a: unknown[]) => console.log('[xv-smoke]', ...a);

function usage(id: string) {
  let tokens = 0;
  let invocations = 0;
  for (const t of listTasksByTicket(id))
    for (const r of recentRunsForTask(t.id, 100)) {
      invocations++;
      tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    }
  return { tokens, invocations, wallMs: Date.now() - start };
}
function breach(u: ReturnType<typeof usage>): string | null {
  if (u.invocations > CAPS.invocations) return `invocations ${u.invocations} > ${CAPS.invocations}`;
  if (u.tokens > CAPS.tokens) return `tokens ${u.tokens} > ${CAPS.tokens}`;
  if (u.wallMs > CAPS.wallMs) return `wall-clock ${(u.wallMs / 60000).toFixed(1)}min > 12min`;
  return null;
}

async function main(): Promise<void> {
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = s@localhost\n\tname = S\n',
  );
  scaffoldThalos(repo, { phase: 'maintenance', orchestratorProvider: 'claude' });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\nsmoke.db*\n');
  // A real bug, but NO pre-seeded test — the bug-fix workflow's test-author writes the repro itself
  // (a pre-seeded failing test confused it into a doom-loop last time). The bug-fix workflow has the
  // adversarial REVIEWER stage (the feature workflow does not), so this is the vehicle that reaches the
  // genuinely-cross-vendor reviewer.
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 'mathlib',
      type: 'module',
      scripts: {
        test: 'node test.mjs',
        build: 'node -e ""',
        typecheck: 'node -e ""',
        lint: 'node -e ""',
      },
    }),
  );
  fs.writeFileSync(
    path.join(repo, 'src.mjs'),
    'export const sum = (a, b) => a - b; // BUG: should be a + b\n',
  );
  await git.add('.');
  await git.commit('init (with bug, no test yet)');

  runMigrations(openDb());
  insertProject({
    id: 'xv',
    name: 'sumbug',
    repoPath: repo,
    origin: 'scratch',
    phase: 'maintenance',
    orchestratorProvider: 'claude',
    createdAt: Date.now(),
  });
  const detected = await detectAll();
  log(
    'detected:',
    detected.map((d) => `${d.id}(inst=${d.installed},auth=${d.authenticated})`).join(', '),
  );

  const runtime = createRuntime();
  log('intake (live) — fix the sum bug; reviewer must differ from the engineer vendor…');
  const ticket = await intakeTicket(runtime.engine, {
    projectId: 'xv',
    title: 'Fix the sum bug',
    body: 'src.mjs `sum(a, b)` returns `a - b` but must return `a + b`. Write a test that reproduces this (sum(2,3) should be 5), then make the minimal fix.',
    mode: 'live',
  });
  const id = ticket.id;

  let abortReason: string | null = null;
  for (let i = 0; i < 40; i++) {
    const t = getTicket(id);
    if (!t || TERMINAL.has(t.status)) break;
    const b = breach(usage(id));
    if (b) {
      abortReason = b;
      log(`CAP BREACHED: ${b} → AUTO-ABORT`);
      setTicketStatus(id, 'aborted');
      break;
    }
    const u = usage(id);
    log(
      `step ${i}: status=${t.status} invokes=${u.invocations} tokens=${u.tokens} wall=${(u.wallMs / 1000).toFixed(0)}s`,
    );
    try {
      if (t.status === 'blocked') {
        const g = listGatesByTicket(id).find((g) => g.status === 'pending');
        if (!g) break;
        log(`  approving gate "${g.title ?? g.kind}"`);
        await runtime.engine.resolveHumanGate(g.id, 'approve', 'xv');
      } else {
        await runtime.engine.advance(id);
      }
    } catch (e) {
      abortReason = `advance threw: ${String(e).slice(0, 200)}`;
      log('ADVANCE THREW:', String(e).slice(0, 300));
      break;
    }
  }

  // ---------- report: which vendor ran each stage ----------
  const tasks = listTasksByTicket(id);
  const stageProvider: Record<string, string> = {};
  for (const t of tasks) {
    const runs = recentRunsForTask(t.id, 10);
    if (runs[0]?.provider) stageProvider[t.stageId] = runs[0].provider;
  }
  const u = usage(id);
  console.log('\n========== TWO-VENDOR ROUND-TRIP REPORT ==========');
  console.log(
    'ticket status   :',
    getTicket(id)?.status,
    abortReason ? `(aborted: ${abortReason})` : '',
  );
  console.log('stage → provider (vendor that actually ran):');
  for (const [stage, prov] of Object.entries(stageProvider))
    console.log(`   ${stage.padEnd(14)} ${prov}`);
  const vendors = [...new Set(Object.values(stageProvider))];
  console.log(
    'distinct vendors:',
    vendors.join(', '),
    vendors.length >= 2 ? '✓ cross-vendor' : '(single vendor)',
  );
  console.log(
    `actuals         : ${u.invocations}/${CAPS.invocations} invokes, ${u.tokens}/${CAPS.tokens} tok, ${(u.wallMs / 60000).toFixed(1)}/12 min`,
  );
  console.log('repo            :', repo);
  console.log('==================================================\n');
}

await main();
