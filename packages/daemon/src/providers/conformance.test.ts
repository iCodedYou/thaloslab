// Adapter conformance + enforce mapping for codex/gemini.
//
// TWO CLAIMS, KEPT DISTINCT:
//  - These tests prove the PARSER LOGIC handles the (reconstructed) output shape, and that the
//    enforce() MAPPING is what we intend.
//  - They do NOT prove real Codex/Gemini produce this output, nor that they actually can/can't
//    enforce a constraint. The fixtures are RECONSTRUCTED, not captured (no CLI installed here) —
//    see fixtures/streams/PROVENANCE.md. Conformance is UNVERIFIED until re-validated on install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderEvent, ToolPolicy } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { enforceCodex, parseCodexLine } from './codex';
import { enforceGemini, parseGeminiLine } from './gemini';

const STREAMS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/streams',
);
// Version each fixture was authored against; a mismatch with an installed CLI ⇒ re-capture the
// fixture, not just the code (recorded fixtures go stale silently).
const CODEX_FIXTURE_VERSION = '0.x';
const GEMINI_FIXTURE_VERSION = '0.x';

function fixtureLines(name: string): string[] {
  return fs.readFileSync(path.join(STREAMS, name), 'utf8').split('\n');
}

const policy = (over: Partial<ToolPolicy>): ToolPolicy => ({
  canRead: true,
  canWrite: false,
  canExecCommands: false,
  network: 'none',
  pathScope: 'own-worktree',
  ...over,
});

describe(`codex parser conformance (RECONSTRUCTED ${CODEX_FIXTURE_VERSION}, UNVERIFIED vs real CLI)`, () => {
  it('parses the codex exec --json stream into text + tool events + a non-error result', () => {
    const events: ProviderEvent[] = [];
    let isError: boolean | undefined;
    for (const line of fixtureLines('codex-exec.jsonl')) {
      const r = parseCodexLine(line);
      events.push(...r.events);
      if (r.result) isError = r.result.isError;
    }
    const text = events
      .filter((e): e is { type: 'stdout'; chunk: string } => e.type === 'stdout')
      .map((e) => e.chunk)
      .join(' ');
    expect(text).toContain('fix the sum bug');
    expect(text).toContain('a + b');
    expect(events.some((e) => e.type === 'tool' && e.name === 'Bash')).toBe(true);
    expect(isError).toBe(false);
  });
});

describe(`gemini parser conformance (RECONSTRUCTED ${GEMINI_FIXTURE_VERSION}, UNVERIFIED vs real CLI)`, () => {
  it('surfaces plain-text headless output as stdout', () => {
    const text = fixtureLines('gemini-text.txt')
      .flatMap((l) => parseGeminiLine(l).events)
      .filter((e): e is { type: 'stdout'; chunk: string } => e.type === 'stdout')
      .map((e) => e.chunk)
      .join(' ');
    expect(text).toContain('timestamp helper');
    expect(text).toContain('timestamped()');
  });

  it('parses the structured-output variant into stdout + a non-error result', () => {
    let isError: boolean | undefined;
    const text: string[] = [];
    for (const line of fixtureLines('gemini-json.jsonl')) {
      const r = parseGeminiLine(line);
      for (const e of r.events) if (e.type === 'stdout') text.push(e.chunk);
      if (r.result) isError = r.result.isError;
    }
    expect(text.join(' ')).toContain('timestamped()');
    expect(isError).toBe(false);
  });
});

describe('codex/gemini enforce mapping (ASSUMED, UNVERIFIED vs real CLI --help)', () => {
  it('codex: read-only is enforceable (differ roles); a per-command allowlist is UNMET (builders)', () => {
    expect(enforceCodex(policy({})).unmet).toEqual([]);
    expect(enforceCodex(policy({})).args).toContain('read-only');
    expect(
      enforceCodex(policy({ canWrite: true, canExecCommands: true, commandAllowlist: ['git *'] }))
        .unmet,
    ).toContain('command-allowlist');
  });

  it('gemini: read-only + network:none is enforceable (excludes write/shell/web); allowlist UNMET', () => {
    const ro = enforceGemini(policy({}));
    expect(ro.unmet).toEqual([]);
    expect(ro.args.join(' ')).toContain('run_shell_command'); // excluded
    expect(
      enforceGemini(policy({ canWrite: true, canExecCommands: true, commandAllowlist: ['git *'] }))
        .unmet,
    ).toContain('command-allowlist');
  });
});
