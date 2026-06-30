// Adapter conformance + enforce mapping for codex/gemini.
//
// TWO CLAIMS, KEPT DISTINCT (status now differs per provider — see fixtures/streams/PROVENANCE.md):
//  - CODEX: ✅ VERIFIED-AGAINST-REAL-CLI (codex-cli 0.142.2). The enforce-mapping was checked against the
//    real `--help`, and the parser against REAL `codex exec --json` captures (this fixture IS a real
//    capture). The reconstructed mapping had a too-loose network claim + a rejected `--ask-for-approval`
//    flag — both fixed (see codex.ts header).
//  - GEMINI: enforce-mapping ✅ VERIFIED vs real `gemini --help` (0.49.0) + reality tests (the old
//    `--exclude-tools` mechanism was INVALID — fixed). Parser ⚠️ PARTIALLY-VERIFIED: the stream-json
//    ENVELOPE (init / message{role,content}) is a real capture, but the assistant/result line is INFERRED
//    (a clean capture was blocked by gemini API 503s) — stays DEFERRED-PENDING-INSTALL (re-capture).
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
// The CLI version each fixture was CAPTURED from. A mismatch with the installed CLI ⇒ re-capture the
// fixture, not just the code (recorded fixtures go stale silently).
const CODEX_FIXTURE_VERSION = '0.142.2';
const GEMINI_FIXTURE_VERSION = '0.49.0';

function fixtureLines(name: string): string[] {
  return fs.readFileSync(path.join(STREAMS, name), 'utf8').split('\n');
}
const stdoutOf = (events: ProviderEvent[]) =>
  events
    .filter((e): e is { type: 'stdout'; chunk: string } => e.type === 'stdout')
    .map((e) => e.chunk)
    .join(' ');

const policy = (over: Partial<ToolPolicy>): ToolPolicy => ({
  canRead: true,
  canWrite: false,
  canExecCommands: false,
  network: 'none',
  pathScope: 'own-worktree',
  ...over,
});

describe(`codex parser conformance (REAL capture, codex-cli ${CODEX_FIXTURE_VERSION})`, () => {
  it('parses the REAL codex exec --json stream: agent text + a Bash tool event + a non-error result', () => {
    const events: ProviderEvent[] = [];
    let isError: boolean | undefined;
    for (const line of fixtureLines('codex-exec.jsonl')) {
      const r = parseCodexLine(line);
      events.push(...r.events);
      if (r.result) isError = r.result.isError;
    }
    const text = stdoutOf(events);
    expect(text).toContain('done'); // the agent_message reply
    expect(events.some((e) => e.type === 'tool' && e.name === 'Bash')).toBe(true); // command_execution
    expect(isError).toBe(false); // turn.completed (not an error)
    // …and the benign `item.completed{item:{type:'error', message:"Skill descriptions…"}}` is NEITHER
    // surfaced as output NOR mistaken for a turn error (it's an item-level note, not a turn failure).
    expect(text).not.toContain('Skill descriptions');
  });
});

describe(`gemini parser conformance (gemini ${GEMINI_FIXTURE_VERSION}; envelope REAL, assistant INFERRED)`, () => {
  it('stream-json: the assistant message is surfaced; the user echo + init carry no output', () => {
    const events: ProviderEvent[] = [];
    for (const line of fixtureLines('gemini-stream.jsonl'))
      events.push(...parseGeminiLine(line).events);
    const text = stdoutOf(events);
    expect(text).toContain('OK'); // the assistant `message{role:'assistant', content}`
    expect(text).not.toContain('Reply with exactly'); // the user-prompt echo is NOT output
    expect(text).not.toContain('"session_id"'); // the init line carries no output
  });

  it('text mode (non-JSON): the raw line is surfaced as stdout (tolerant fallback)', () => {
    const text = stdoutOf(
      fixtureLines('gemini-text.txt').flatMap((l) => parseGeminiLine(l).events),
    );
    expect(text).toContain('timestamp helper');
    expect(text).toContain('timestamped()');
  });
});

describe(`codex enforce mapping (VERIFIED vs real codex-cli ${CODEX_FIXTURE_VERSION} --help)`, () => {
  it('read-only differ: --sandbox read-only, NO --ask-for-approval, nothing unmet', () => {
    const ro = enforceCodex(policy({}));
    expect(ro.args).toContain('read-only');
    expect(ro.args).not.toContain('--ask-for-approval'); // the real exec REJECTS this flag
    expect(ro.unmet).toEqual([]);
  });
  it('builder: workspace-write, per-command allowlist UNMET (coarse sandbox)', () => {
    const b = enforceCodex(
      policy({ canWrite: true, canExecCommands: true, commandAllowlist: ['git *'] }),
    );
    expect(b.args).toContain('workspace-write');
    expect(b.unmet).toContain('command-allowlist');
  });
  it('network:none builder EXPLICITLY disables network (not the user-overridable default)', () => {
    const b = enforceCodex(policy({ canWrite: true, canExecCommands: true, network: 'none' }));
    expect(b.args.join(' ')).toContain('sandbox_workspace_write.network_access=false');
  });
});

describe(`gemini enforce mapping (VERIFIED vs real gemini ${GEMINI_FIXTURE_VERSION} --help)`, () => {
  it('read-only differ: --approval-mode plan + --skip-trust + stream-json, NO --exclude-tools, nothing unmet', () => {
    const ro = enforceGemini(policy({}));
    expect(ro.args.join(' ')).toContain('--approval-mode plan'); // genuine read-only (no tools run)
    expect(ro.args).toContain('--skip-trust'); // else gemini refuses headless / overrides approval-mode
    expect(ro.args.join(' ')).toContain('stream-json');
    expect(ro.args).not.toContain('--exclude-tools'); // this flag DOES NOT EXIST in gemini 0.49
    expect(ro.unmet).toEqual([]);
  });
  it('builder: --approval-mode yolo; command-allowlist AND network-none UNMET (fail closed — no web-disable)', () => {
    const b = enforceGemini(
      policy({
        canWrite: true,
        canExecCommands: true,
        commandAllowlist: ['git *'],
        network: 'none',
      }),
    );
    expect(b.args.join(' ')).toContain('--approval-mode yolo');
    expect(b.unmet).toContain('command-allowlist');
    expect(b.unmet).toContain('network-none'); // web tools active in auto-approve; can't disable cleanly
    expect(b.args).not.toContain('--exclude-tools');
  });
});
