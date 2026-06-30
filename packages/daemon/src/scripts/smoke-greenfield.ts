// Capped greenfield smoke (clears DEFERRED-PENDING-BUDGET). This is a VERIFICATION HARNESS only — it
// does NOT touch the greenfield engine. It drives a real architect inventing structure from a spec, with
// HARD caps + AUTO-ABORT on the first breach: ≤2 lanes / ≤300k tokens / ≤15min wall-clock / ≤12
// invocations. The breaching step is detected after it completes; the harness then stops before the next
// invoke and reports a partial result (a cap hit is a valid, reported outcome — not a failure).
//
//   dry-run (zero tokens, validates the harness):  THALOS_SMOKE_MODE=mock pnpm --filter @thaloslab/daemon exec tsx src/scripts/smoke-greenfield.ts
//   live    (REAL tokens, capped):                 THALOS_SMOKE_MODE=live pnpm --filter @thaloslab/daemon exec tsx src/scripts/smoke-greenfield.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { InvokeOptions } from '@thaloslab/shared';
import type { MockBehavior } from '../providers/mock';

const MODE: 'live' | 'mock' = process.env.THALOS_SMOKE_MODE === 'live' ? 'live' : 'mock';
const CAPS = { lanes: 2, tokens: 300_000, wallMs: 15 * 60_000, invocations: 12 };
const start = Date.now();

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-gf-smoke-'));
process.env.THALOS_DB_PATH = path.join(repo, 'smoke.db');

const { openDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { getTicket, setTicketStatus } = await import('../store/repositories/tickets');
const { listTasksByTicket } = await import('../store/repositories/tasks');
const { listGatesByTicket } = await import('../store/repositories/gates');
const { recentRunsForTask } = await import('../store/repositories/runs');
const { upsertProvider } = await import('../store/repositories/providers');
const { detectAll } = await import('../providers/registry');
const { scaffoldThalos } = await import('../store/thalos-layout');
const { createRuntime } = await import('../workflow/runtime');
const { intakeTicket } = await import('../workflow/orchestrator/intake');
const mock = MODE === 'mock' ? await import('../providers/mock') : null;

const TERMINAL = new Set(['done', 'failed', 'escalated', 'aborted', 'preview-complete']);
const log = (...a: unknown[]) => console.log('[gf-smoke]', ...a);

// A small, well-specified greenfield spec with TWO naturally-independent concerns. We do NOT dictate the
// seam paths — the architect must invent the structure (the open question: do real decompositions stay
// disjoint with no existing code to read?).
const TITLE = 'Build a tiny CLI: count lines, words, and bytes of stdin (a minimal wc)';
const BODY = [
  'Build a small Node.js CLI `wc-lite` that reads text from stdin and prints three counts: lines, words, and bytes (like a minimal `wc`).',
  'There are two INDEPENDENT concerns; decompose along that seam IF it is genuinely disjoint, otherwise return one sequential item:',
  '  (1) COUNTING: pure functions that, given a string, return { lines, words, bytes }.',
  '  (2) CLI/IO: read all of stdin, call the counting logic, and print the three counts.',
  'Keep the two concerns in separate modules so each can be built and tested independently.',
  "Acceptance: piping the text 'hello world\\n' must yield lines=1, words=2, bytes=12.",
].join('\n');

// ---- mock program (dry-run only): a scripted 2-seam buildable greenfield, mirroring greenfield-e2e ----
function installMock(): void {
  const NOOP = 'node -e ""';
  const ACCEPTANCE = [
    "import { a } from './src/a/index.mjs';",
    "import { b } from './src/b/index.mjs';",
    "if (a() !== 1) { console.error('a'); process.exit(1); }",
    "if (b() !== 2) { console.error('b'); process.exit(1); }",
    "console.log('acceptance PASS');",
  ].join('\n');
  const PKG = JSON.stringify({
    name: 'mvp',
    type: 'module',
    scripts: { build: NOOP, typecheck: NOOP, lint: NOOP, test: 'node acceptance.mjs' },
  });
  mock!.setMockProgram((invoke: InvokeOptions): MockBehavior => {
    const p = invoke.prompt;
    if (p.includes('Stage: spec'))
      return {
        ok: true,
        writeFiles: {
          'docs/mvp-spec.md':
            '# MVP\n## Acceptance criteria (testable)\n- src/a exports a()===1\n- src/b exports b()===2\n## Seams\n- src/a\n- src/b\n',
        },
      };
    if (p.includes('Stage: scaffold') && !p.includes('Stage: scaffold-integrate'))
      return {
        ok: true,
        writeFiles: {
          'package.json': PKG,
          'acceptance.mjs': ACCEPTANCE,
          'src/a/index.mjs': 'export const a = () => 0;\n',
          'src/b/index.mjs': 'export const b = () => 0;\n',
        },
      };
    if (p.includes('Stage: decompose'))
      return {
        ok: true,
        writeFiles: {
          'decomposition.json': JSON.stringify([
            { seamPaths: ['src/a'], summary: 'A' },
            { seamPaths: ['src/b'], summary: 'B' },
          ]),
        },
      };
    if (p.includes('src/a'))
      return { ok: true, writeFiles: { 'src/a/index.mjs': 'export const a = () => 1;\n' } };
    if (p.includes('src/b'))
      return { ok: true, writeFiles: { 'src/b/index.mjs': 'export const b = () => 2;\n' } };
    return { ok: true };
  });
}

function usage(id: string) {
  let tokens = 0;
  let invocations = 0;
  const lanes = new Set<string>();
  for (const t of listTasksByTicket(id)) {
    if (t.laneId && /seam/.test(t.laneId)) lanes.add(t.laneId);
    for (const r of recentRunsForTask(t.id, 100)) {
      invocations++;
      tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    }
  }
  return { tokens, invocations, lanes: lanes.size, wallMs: Date.now() - start };
}

function breach(u: ReturnType<typeof usage>): string | null {
  if (u.invocations > CAPS.invocations) return `invocations ${u.invocations} > ${CAPS.invocations}`;
  if (u.tokens > CAPS.tokens) return `tokens ${u.tokens} > ${CAPS.tokens}`;
  if (u.wallMs > CAPS.wallMs) return `wall-clock ${(u.wallMs / 60000).toFixed(1)}min > 15min`;
  if (u.lanes > CAPS.lanes) return `lanes ${u.lanes} > ${CAPS.lanes}`;
  return null;
}

async function main(): Promise<void> {
  log(
    `MODE=${MODE} (caps: ≤${CAPS.lanes} lanes / ≤${CAPS.tokens / 1000}k tok / ≤15min / ≤${CAPS.invocations} invokes)`,
  );
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = s@localhost\n\tname = S\n',
  );
  scaffoldThalos(repo, { phase: 'bootstrapping', orchestratorProvider: 'claude' });
  fs.writeFileSync(path.join(repo, 'README.md'), '# wc-lite\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\nsmoke.db*\n');
  await git.add('.');
  await git.commit('Initial commit');

  runMigrations(openDb());
  insertProject({
    id: 'gf',
    name: 'wc-lite',
    repoPath: repo,
    origin: 'scratch',
    phase: 'bootstrapping',
    orchestratorProvider: 'claude',
    createdAt: Date.now(),
  });
  if (mock) {
    installMock();
    upsertProvider({
      id: 'claude',
      kind: 'local',
      displayName: 'Claude',
      installed: true,
      authenticated: true,
      lastChecked: Date.now(),
    });
  } else {
    // --live: detect the REAL installed providers (zero-token probe). Greenfield needs an available
    // provider to assign agents; without one the roster can't assemble and the ticket escalates.
    const detected = await detectAll();
    log(
      'detected providers:',
      detected.map((d) => `${d.id}(installed=${d.installed},auth=${d.authenticated})`).join(', '),
    );
  }

  const runtime = createRuntime();
  log('intake — architect will design the spec + decompose…');
  const ticket = await intakeTicket(runtime.engine, {
    projectId: 'gf',
    title: TITLE,
    body: BODY,
    mode: MODE,
  });
  const id = ticket.id;

  let abortReason: string | null = null;
  for (let i = 0; i < 60; i++) {
    const t = getTicket(id);
    if (!t || TERMINAL.has(t.status)) break;
    const u = usage(id);
    const b = breach(u);
    if (b) {
      abortReason = b;
      log(`CAP BREACHED: ${b} → AUTO-ABORT (partial result)`);
      setTicketStatus(id, 'aborted');
      break;
    }
    log(
      `step ${i}: status=${t.status} invokes=${u.invocations} tokens=${u.tokens} lanes=${u.lanes} wall=${(u.wallMs / 1000).toFixed(0)}s`,
    );
    try {
      if (t.status === 'blocked') {
        const g = listGatesByTicket(id).find((g) => g.status === 'pending');
        if (!g) {
          log('blocked with no pending gate — stopping');
          break;
        }
        log(`  approving gate "${g.title ?? g.kind}"`);
        await runtime.engine.resolveHumanGate(g.id, 'approve', 'gf-smoke');
      } else {
        await runtime.engine.advance(id);
      }
    } catch (e) {
      abortReason = `advance threw: ${String(e).slice(0, 240)}`;
      log('ADVANCE THREW (a real integration finding):', String(e).slice(0, 400));
      break;
    }
  }

  // ---------- report ----------
  const final = getTicket(id);
  const gates = listGatesByTicket(id);
  const gate = (sub: string) =>
    gates.find((g) => (g.kind ?? '').includes(sub) || (g.title ?? '').toLowerCase().includes(sub));
  const decompPath = path.join(repo, '.thalos', 'artifacts', id, 'decomposition.json');
  const decomp = fs.existsSync(decompPath)
    ? (JSON.parse(fs.readFileSync(decompPath, 'utf8')) as Array<{
        seamPaths: string[];
        summary?: string;
      }>)
    : null;
  const seams =
    decomp?.flatMap((d) => d.seamPaths.map((s) => s.replace(/\\/g, '/').replace(/\/+$/, ''))) ?? [];
  const disjoint = seams.every((x, i) =>
    seams.every((y, j) => i === j || !(x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`))),
  );
  const pkgExists = fs.existsSync(path.join(repo, 'package.json'));
  const acceptanceExists = ['acceptance.mjs', 'acceptance.test.mjs', 'test/acceptance.mjs'].some(
    (f) => fs.existsSync(path.join(repo, f)),
  );
  const u = usage(id);

  console.log('\n========== GREENFIELD CAPPED SMOKE REPORT ==========');
  console.log(
    'mode               :',
    MODE,
    abortReason ? `(auto-aborted: ${abortReason})` : '(ran to a terminal state)',
  );
  console.log('ticket status      :', final?.status);
  console.log('\n1. BUILDABLE SCAFFOLD?');
  console.log('   package.json born:', pkgExists);
  console.log('   acceptance born  :', acceptanceExists);
  console.log('   scaffold-green   :', gate('scaffold')?.status ?? 'n/a');
  console.log('\n2. DISJOINT SEAMS / PARALLEL LANES?');
  console.log('   decomposition    :', decomp ? `${decomp.length} lane(s)` : 'MISSING');
  decomp?.forEach((d, i) =>
    console.log(`     lane ${i}: [${d.seamPaths.join(', ')}] ${d.summary ?? ''}`),
  );
  console.log('   collapsed to 1?  :', decomp ? decomp.length === 1 : 'n/a');
  console.log('   seams disjoint?  :', decomp ? disjoint : 'n/a');
  console.log('   lane worktrees   :', u.lanes);
  console.log('\n3. INTEGRATION-SWEEP (the MVP-exists gate)?');
  console.log(
    '   integration-sweep:',
    gate('integration')?.status ?? gate('sweep')?.status ?? 'n/a (not reached)',
  );
  console.log(
    '   all gates        :',
    gates.map((g) => `${g.kind ?? g.title}:${g.status}`).join(', ') || 'none',
  );
  console.log('\n4. ACTUALS vs CAPS:');
  console.log(`   invocations      : ${u.invocations} / ${CAPS.invocations}`);
  console.log(`   tokens           : ${u.tokens} / ${CAPS.tokens}`);
  console.log(`   wall-clock       : ${(u.wallMs / 60000).toFixed(1)}min / 15min`);
  console.log(`   lanes            : ${u.lanes} / ${CAPS.lanes}`);
  console.log('\nrepo (inspect)     :', repo);
  console.log('====================================================\n');
}

await main();
