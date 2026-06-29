// Gemini (Google) adapter. detect()/enforce() are zero-cost. invoke() drives the `gemini` CLI
// headlessly and maps its output to ProviderEvents; changedFiles come from `git diff` (shared util).
// enforce() maps the neutral ToolPolicy onto Gemini's approval mode + tool config.
//
// ⚠️ CONFORMANCE-UNVERIFIED (DEFERRED-PENDING-INSTALL): Gemini is NOT installed on this machine, so
// the exact CLI flags, output/streaming format, and the permission mapping below are RECONSTRUCTED
// from the documented format at the 2026-01 knowledge cutoff — NOT captured from a real run. The
// version guard + tolerant parser are the mitigations; re-validate the parser against a real capture
// and the enforce() unmet-set against the real `gemini --help` before relying on this in --live.
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

const GEMINI_BIN = 'gemini';
/** Targeted Gemini CLI version (reconstructed; verify against the installed CLI at install time). */
const TESTED_VERSION_PREFIX = '0.';

function checkGeminiAuth(): boolean {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return true;
  try {
    return fs.statSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json')).size > 0;
  } catch {
    return false;
  }
}

const GEMINI_SPEC: CliSpec = {
  bin: GEMINI_BIN,
  versionArgs: ['--version'],
  authCheck: checkGeminiAuth,
  testedPrefix: TESTED_VERSION_PREFIX,
  label: 'gemini',
};

/**
 * Map the neutral policy onto Gemini's approval + tool config. Like Codex, Gemini expresses a tool
 * SET (read/write/shell/web) and an approval mode, NOT a per-command allowlist — so a
 * `commandAllowlist` is UNMET (the router fails closed off Gemini for builders). Read-only +
 * network:none map cleanly (exclude the write/shell/web tools), so the differ roles route fine.
 */
export function enforceGemini(policy: ToolPolicy): EnforceResult {
  const excluded: string[] = [];
  const unmet: string[] = [];
  if (!policy.canWrite) excluded.push('write_file', 'replace');
  if (!policy.canExecCommands) excluded.push('run_shell_command');
  if (policy.network === 'none') excluded.push('web_fetch', 'google_web_search');

  const args = ['--yolo']; // non-interactive auto-approve within the restricted tool set
  if (excluded.length) args.push('--exclude-tools', excluded.join(','));
  // Gemini cannot restrict shell to a per-command allowlist.
  if (policy.canExecCommands && policy.commandAllowlist?.length) unmet.push('command-allowlist');
  if (policy.network === 'allowlist' && policy.networkAllowlist?.length)
    unmet.push('network-allowlist');
  return { args, unmet };
}

interface GeminiLine {
  type?: string;
  response?: string;
  content?: string;
  text?: string;
  error?: unknown;
}

/** Tolerant parse of a Gemini output line → ProviderEvents. If the CLI emits plain text (not JSON),
 *  the raw line is surfaced as stdout. */
export function parseGeminiLine(line: string): {
  events: ProviderEvent[];
  result?: { text: string; isError: boolean };
} {
  const trimmed = line.trim();
  if (!trimmed) return { events: [] };
  try {
    const obj = JSON.parse(trimmed) as GeminiLine;
    const text = obj.response ?? obj.content ?? obj.text ?? '';
    if (obj.error)
      return {
        events: text ? [{ type: 'stdout', chunk: text }] : [],
        result: { text: String(text), isError: true },
      };
    if (obj.type === 'result' || obj.response !== undefined) {
      return {
        events: text ? [{ type: 'stdout', chunk: text }] : [],
        result: { text, isError: false },
      };
    }
    return { events: text ? [{ type: 'stdout', chunk: text }] : [] };
  } catch {
    // Plain-text streaming output: surface the line as stdout.
    return { events: [{ type: 'stdout', chunk: trimmed }] };
  }
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  displayName: 'Gemini',
  detect: () => detectCli(GEMINI_SPEC),
  capabilities: () => ({
    canEditFiles: true,
    canRunCommands: true,
    streaming: true,
    structuredOutput: false,
  }),
  enforce: enforceGemini,
  async *invoke(opts: InvokeOptions): AsyncIterable<ProviderEvent> {
    const resolved = whichSync(GEMINI_BIN);
    if (!resolved) {
      yield {
        type: 'result',
        result: {
          ok: false,
          output: 'gemini CLI not found',
          artifacts: [],
          changedFiles: [],
          raw: {},
        },
      };
      return;
    }
    await guardVersion(resolved, TESTED_VERSION_PREFIX, 'gemini');
    const args = [...enforceGemini(opts.policy).args, '--prompt', opts.prompt];

    yield { type: 'status', status: 'invoking gemini' };
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
        const { events, result } = parseGeminiLine(line);
        for (const e of events) {
          if (e.type === 'stdout') out += `${e.chunk}\n`;
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
