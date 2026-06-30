// Codex (OpenAI) adapter. detect()/enforce() are zero-cost. invoke() drives `codex exec --json`,
// parsing its JSONL event stream into ProviderEvents; changedFiles come from `git diff` (shared
// util). enforce() maps the neutral ToolPolicy onto Codex's sandbox + approval model.
//
// ✅ VERIFIED-AGAINST-REAL-CLI (codex-cli 0.142.2, 2026-06-30). The enforce-mapping + parser were
// checked against the real CLI's `--help` and a real `codex exec --json` capture. Corrections from the
// reconstructed version: (1) REMOVED `--ask-for-approval never` — `exec` is non-interactive and the
// real CLI REJECTS that flag (it would have failed every run); (2) network:none now EXPLICITLY passes
// `-c sandbox_workspace_write.network_access=false` instead of trusting the (user-config-OVERRIDABLE)
// default — closing a too-loose mapping. Confirmed correct as-was: `--sandbox read-only|workspace-write`
// (coarse — so `command-allowlist`/`no-exec` are genuinely UNMET), `--json` JSONL. The parser matches
// the real stream (thread.started → turn.started → item.completed{agent_message} → turn.completed).
// changedFiles still come from host git, never the model's self-report.
// ⚠️ Detection gap: codex installs OFF-PATH here (~/AppData/Local/OpenAI/Codex/bin/<hash>) — `whichSync`
// needs it on PATH to detect()/invoke() it (DEFERRED-PENDING-INSTALL: codex-on-PATH).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type EnforceResult,
  type InvokeOptions,
  type InvokeResult,
  type ProviderAdapter,
  type ProviderEvent,
  type ToolPolicy,
} from '@thaloslab/shared';
import { changedFiles } from '../util/git';
import { lines } from '../util/stream';
import { type CliSpec, detectCli, guardVersion } from './detect-cli';
import { spawnSandboxed } from './sandbox/spawn';
import { whichSync } from './which';

const CODEX_BIN = 'codex';
/** Targeted Codex CLI version (reconstructed; verify against the installed CLI at install time). */
const TESTED_VERSION_PREFIX = '0.';

function checkCodexAuth(): boolean {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;
  try {
    // ChatGPT login persists credentials under ~/.codex.
    return fs.statSync(path.join(os.homedir(), '.codex', 'auth.json')).size > 0;
  } catch {
    return false;
  }
}

const CODEX_SPEC: CliSpec = {
  bin: CODEX_BIN,
  versionArgs: ['--version'],
  authCheck: checkCodexAuth,
  testedPrefix: TESTED_VERSION_PREFIX,
  label: 'codex',
};

/**
 * Map the neutral policy onto Codex's sandbox + approval model. Codex expresses coarse sandbox
 * levels, NOT a per-tool/per-command allowlist — so a `commandAllowlist` is UNMET (the router then
 * fails closed off Codex for builders). Read-only maps cleanly (the differ roles).
 */
export function enforceCodex(policy: ToolPolicy): EnforceResult {
  // `exec` is non-interactive — it never prompts, so there is NO `--ask-for-approval` flag (the real
  // codex-cli 0.142 REJECTS it). The sandbox MODE is the containment; `--json` streams JSONL events.
  const args = ['exec', '--json'];
  const unmet: string[] = [];
  if (!policy.canWrite && !policy.canExecCommands) {
    args.push('--sandbox', 'read-only'); // differ roles: no writes, no exec, no network
  } else if (policy.canExecCommands) {
    args.push('--sandbox', 'workspace-write');
    // Codex's sandbox is COARSE (read-only / workspace-write / danger-full-access) — there is no
    // per-command allowlist flag, so this constraint is genuinely UNMET.
    if (policy.commandAllowlist?.length) unmet.push('command-allowlist');
  } else {
    // write-but-no-exec: workspace-write also permits shell → cannot guarantee no-exec.
    args.push('--sandbox', 'workspace-write');
    unmet.push('no-exec');
  }
  // network:none — workspace-write's network IS off by DEFAULT, but a user `~/.codex/config` could turn
  // it ON, so enforce it EXPLICITLY (never rely on a user-overridable default for containment). The
  // read-only mode has no network by the mode. A precise per-domain allowlist is not expressible.
  if (policy.network === 'none' && (policy.canWrite || policy.canExecCommands))
    args.push('-c', 'sandbox_workspace_write.network_access=false');
  if (policy.network === 'allowlist' && policy.networkAllowlist?.length)
    unmet.push('network-allowlist');
  return { args, unmet };
}

interface CodexLine {
  type?: string;
  msg?: { type?: string; message?: string; text?: string };
  item?: { type?: string; text?: string };
  text?: string;
  delta?: string;
}

/** Tolerant per-line parse of `codex exec --json` JSONL → ProviderEvents. Unknown lines are ignored.
 *  Returns events + (when present) the final result text / error flag. */
export function parseCodexLine(line: string): {
  events: ProviderEvent[];
  result?: { isError: boolean };
} {
  const trimmed = line.trim();
  if (!trimmed) return { events: [] };
  let obj: CodexLine;
  try {
    obj = JSON.parse(trimmed) as CodexLine;
  } catch {
    return { events: [] };
  }
  const kind = obj.type ?? '';
  const itemType = obj.item?.type ?? obj.msg?.type ?? '';
  const text = obj.item?.text ?? obj.text ?? obj.delta ?? obj.msg?.message ?? obj.msg?.text ?? '';
  const events: ProviderEvent[] = [];
  if (/command|exec|shell/i.test(itemType) || /command|exec/i.test(kind)) {
    events.push({ type: 'tool', name: 'Bash' });
  }
  if (text && /message|agent|assistant|text/i.test(`${itemType} ${kind}`)) {
    events.push({ type: 'stdout', chunk: text });
  }
  if (/turn\.completed|task_complete|^result$|error/i.test(kind)) {
    return { events, result: { isError: /error/i.test(kind) || obj.msg?.type === 'error' } };
  }
  return { events };
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',
  detect: () => detectCli(CODEX_SPEC),
  capabilities: () => ({
    canEditFiles: true,
    canRunCommands: true,
    streaming: true,
    structuredOutput: true,
  }),
  enforce: enforceCodex,
  async *invoke(opts: InvokeOptions): AsyncIterable<ProviderEvent> {
    const resolved = whichSync(CODEX_BIN);
    if (!resolved) {
      yield {
        type: 'result',
        result: {
          ok: false,
          output: 'codex CLI not found',
          artifacts: [],
          changedFiles: [],
          raw: {},
        },
      };
      return;
    }
    await guardVersion(resolved, TESTED_VERSION_PREFIX, 'codex');
    const args = [...enforceCodex(opts.policy).args, opts.prompt];

    yield { type: 'status', status: 'invoking codex' };
    const child = spawnSandboxed(
      resolved,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 300_000,
        reject: false,
        buffer: false,
        stripFinalNewline: false,
      },
      opts.sandbox,
    );

    let out = '';
    let isError = false;
    if (child.stdout) {
      for await (const line of lines(child.stdout)) {
        const { events, result } = parseCodexLine(line);
        for (const e of events) {
          if (e.type === 'stdout') out += e.chunk;
          yield e;
        }
        if (result) isError = result.isError;
      }
    }
    const final = await child;
    const files = await changedFiles(opts.cwd);
    const result: InvokeResult = {
      ok: !isError && (final.exitCode ?? 0) === 0,
      output: out.trim(),
      artifacts: [],
      changedFiles: files,
      raw: { exitCode: final.exitCode, timedOut: final.timedOut },
    };
    yield { type: 'result', result };
  },
};
