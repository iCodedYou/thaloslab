// Deterministic gate evaluation (SPEC §2 — verification is the backbone, never an LLM judgment).
// Maps a GateCheck to a command spawned in the task worktree; pass/fail is mechanical (exit code).
// Also supports single-test targeting (repro-red asserts the SPECIFIC test fails) and a regression
// baseline (the fix gate asserts the targeted test passes AND nothing previously-green regressed).
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { GateCheck } from '@thaloslab/shared';

export interface GateCommand {
  command: string;
  args: string[];
}
export type GateCommandMap = Partial<Record<GateCheck, GateCommand>>;

export interface GateRunResult {
  check: GateCheck;
  ok: boolean;
  exitCode: number;
  output: string;
}

/** Detect gate commands from a repo's package.json scripts (pnpm), overridable per project. */
export function detectGateCommands(repoPath: string, runner = 'pnpm'): GateCommandMap {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    /* no package.json — empty map; caller supplies overrides */
  }
  const map: GateCommandMap = {};
  if (scripts.build) map.build = { command: runner, args: ['run', 'build'] };
  if (scripts.typecheck) map.typecheck = { command: runner, args: ['run', 'typecheck'] };
  if (scripts.lint) map.lint = { command: runner, args: ['run', 'lint'] };
  if (scripts.test) map.unit = { command: runner, args: ['run', 'test'] };
  return map;
}

export async function runCheck(
  check: GateCheck,
  cmd: GateCommand,
  cwd: string,
  timeoutMs = 120_000,
): Promise<GateRunResult> {
  const res = await execa(cmd.command, cmd.args, {
    cwd,
    timeout: timeoutMs,
    reject: false,
    all: true,
  });
  return { check, ok: res.exitCode === 0, exitCode: res.exitCode ?? -1, output: res.all ?? '' };
}

// ---- Per-test results: single-test targeting + regression baseline ----

export interface TestCaseResult {
  id: string;
  passed: boolean;
}
export interface SuiteResult {
  ok: boolean;
  cases: TestCaseResult[];
  output: string;
}

/** Pluggable parser of a test command's machine-readable output into per-test results. */
export type SuiteParser = (stdout: string) => TestCaseResult[];

export async function runSuite(
  cmd: GateCommand,
  cwd: string,
  parse: SuiteParser,
  timeoutMs = 120_000,
): Promise<SuiteResult> {
  const res = await execa(cmd.command, cmd.args, {
    cwd,
    timeout: timeoutMs,
    reject: false,
    all: true,
  });
  const output = res.all ?? '';
  return { ok: res.exitCode === 0, cases: parse(output), output };
}

export function failingTests(cases: TestCaseResult[]): Set<string> {
  return new Set(cases.filter((c) => !c.passed).map((c) => c.id));
}

/** repro-red: the targeted reproduction test must be present AND failing (the bug is reproduced). */
export function reproIsRed(cases: TestCaseResult[], testId: string): boolean {
  const c = cases.find((x) => x.id === testId);
  return c !== undefined && !c.passed;
}

/** fix gate: the targeted test now passes AND no previously-green test regressed. */
export function fixSatisfied(
  baseline: SuiteResult,
  current: SuiteResult,
  testId: string,
): { ok: boolean; reason?: string } {
  const cur = current.cases.find((x) => x.id === testId);
  if (!cur || !cur.passed) {
    return { ok: false, reason: `reproduction test "${testId}" is not passing` };
  }
  const baselineGreen = new Set(baseline.cases.filter((c) => c.passed).map((c) => c.id));
  const nowFailing = failingTests(current.cases);
  const regressed = [...baselineGreen].filter((id) => nowFailing.has(id));
  if (regressed.length > 0) {
    return { ok: false, reason: `regressed previously-green tests: ${regressed.join(', ')}` };
  }
  return { ok: true };
}
