import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultSuiteParser,
  detectGateCommands,
  fixSatisfied,
  fixSatisfiedAll,
  newlyFailing,
  reproIsRed,
  runCheck,
  runSuite,
  type SuiteParser,
  type SuiteResult,
} from './gates';

function suite(cases: { id: string; passed: boolean }[]): SuiteResult {
  return { ok: cases.every((c) => c.passed), output: '', cases };
}

const cwd = os.tmpdir();

// A trivial parser over a canned JSON shape our fake command prints.
const parse: SuiteParser = (stdout) => {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  return JSON.parse(stdout.slice(start)) as { id: string; passed: boolean }[];
};

function fakeSuite(cases: { id: string; passed: boolean }[], exit: number) {
  return {
    command: 'node',
    args: ['-e', `console.log(JSON.stringify(${JSON.stringify(cases)})); process.exit(${exit})`],
  };
}

describe('runCheck (deterministic, exit-code based)', () => {
  it('passes on exit 0', async () => {
    const r = await runCheck('build', { command: 'node', args: ['-e', 'process.exit(0)'] }, cwd);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('fails on non-zero exit and captures output', async () => {
    const r = await runCheck(
      'lint',
      { command: 'node', args: ['-e', 'console.error("boom"); process.exit(1)'] },
      cwd,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain('boom');
  });
});

describe('repro-red: the specific reproduction test must fail', () => {
  it('is red when the targeted test is present and failing', async () => {
    const suite = await runSuite(
      fakeSuite(
        [
          { id: 'repro::export-500', passed: false },
          { id: 'other', passed: true },
        ],
        1,
      ),
      cwd,
      parse,
    );
    expect(reproIsRed(suite.cases, 'repro::export-500')).toBe(true);
    expect(reproIsRed(suite.cases, 'other')).toBe(false); // passing → not red
  });
});

describe('fix gate: targeted test passes AND no regression', () => {
  const baseline: SuiteResult = {
    ok: false,
    output: '',
    cases: [
      { id: 'repro::export-500', passed: false },
      { id: 'keep::a', passed: true },
      { id: 'keep::b', passed: true },
    ],
  };

  it('ok when the repro test passes and previously-green stay green', () => {
    const current: SuiteResult = {
      ok: true,
      output: '',
      cases: [
        { id: 'repro::export-500', passed: true },
        { id: 'keep::a', passed: true },
        { id: 'keep::b', passed: true },
      ],
    };
    expect(fixSatisfied(baseline, current, 'repro::export-500')).toEqual({ ok: true });
  });

  it('not ok when the repro test still fails', () => {
    const current: SuiteResult = {
      ok: false,
      output: '',
      cases: [
        { id: 'repro::export-500', passed: false },
        { id: 'keep::a', passed: true },
        { id: 'keep::b', passed: true },
      ],
    };
    expect(fixSatisfied(baseline, current, 'repro::export-500').ok).toBe(false);
  });

  it('not ok when a previously-green test regresses', () => {
    const current: SuiteResult = {
      ok: false,
      output: '',
      cases: [
        { id: 'repro::export-500', passed: true },
        { id: 'keep::a', passed: true },
        { id: 'keep::b', passed: false }, // regression
      ],
    };
    const verdict = fixSatisfied(baseline, current, 'repro::export-500');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('keep::b');
  });
});

describe('newlyFailing identifies the reproduction test the test-author added', () => {
  it('returns tests that fail now but did not before', () => {
    const before = suite([{ id: 'keep', passed: true }]);
    const after = suite([
      { id: 'keep', passed: true },
      { id: 'repro::export-500', passed: false },
    ]);
    expect(newlyFailing(before, after)).toEqual(['repro::export-500']);
  });
});

describe('fixSatisfiedAll: precise repro + regression assertions (catches the false-pass)', () => {
  const baselineGreen = ['keep::a', 'keep::b'];
  const reproTestIds = ['repro::export-500'];

  it('ok when the repro test passes and previously-green stay green', () => {
    const current = suite([
      { id: 'repro::export-500', passed: true },
      { id: 'keep::a', passed: true },
      { id: 'keep::b', passed: true },
    ]);
    expect(fixSatisfiedAll(baselineGreen, reproTestIds, current)).toEqual({ ok: true });
  });

  it('REJECTS the false-pass: suite is green overall but the repro test was DELETED/skipped', () => {
    // The cheat: remove the failing reproduction test so the suite goes green without a real fix.
    const current = suite([
      { id: 'keep::a', passed: true },
      { id: 'keep::b', passed: true },
    ]);
    expect(current.ok).toBe(true); // suite-level exit code would PASS here
    const verdict = fixSatisfiedAll(baselineGreen, reproTestIds, current);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('repro::export-500');
  });

  it('REJECTS when the repro test is still failing even though others pass', () => {
    const current = suite([
      { id: 'repro::export-500', passed: false },
      { id: 'keep::a', passed: true },
      { id: 'keep::b', passed: true },
    ]);
    expect(fixSatisfiedAll(baselineGreen, reproTestIds, current).ok).toBe(false);
  });

  it('REJECTS when the repro test passes but a previously-green test regressed', () => {
    const current = suite([
      { id: 'repro::export-500', passed: true },
      { id: 'keep::a', passed: true },
      { id: 'keep::b', passed: false }, // regression
    ]);
    const verdict = fixSatisfiedAll(baselineGreen, reproTestIds, current);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('keep::b');
  });
});

describe('defaultSuiteParser', () => {
  it('parses PASS/FAIL lines and strips trailing messages', () => {
    const cases = defaultSuiteParser('PASS sum(0,0)\nFAIL sum(2,3): expected 5, got -1\n');
    expect(cases).toEqual([
      { id: 'sum(0,0)', passed: true },
      { id: 'sum(2,3)', passed: false },
    ]);
  });
  it('parses TAP and ✓/✗ lines', () => {
    const cases = defaultSuiteParser('ok 1 alpha\nnot ok 2 beta\n✓ gamma\n✗ delta\n');
    expect(cases.find((c) => c.id === 'alpha')?.passed).toBe(true);
    expect(cases.find((c) => c.id === 'beta')?.passed).toBe(false);
    expect(cases.find((c) => c.id === 'gamma')?.passed).toBe(true);
    expect(cases.find((c) => c.id === 'delta')?.passed).toBe(false);
  });
});

describe('detectGateCommands', () => {
  it('maps package.json scripts to pnpm commands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-gate-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsup', test: 'vitest', typecheck: 'tsc' } }),
    );
    const map = detectGateCommands(dir);
    expect(map.build).toEqual({ command: 'pnpm', args: ['run', 'build'] });
    expect(map.unit).toEqual({ command: 'pnpm', args: ['run', 'test'] });
    expect(map.lint).toBeUndefined(); // no lint script
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
