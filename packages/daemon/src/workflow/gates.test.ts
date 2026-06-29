import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectGateCommands,
  fixSatisfied,
  reproIsRed,
  runCheck,
  runSuite,
  type SuiteParser,
  type SuiteResult,
} from './gates';

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
