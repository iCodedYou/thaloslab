// Gemini (Google) adapter. detect()/enforce() are zero-cost. invoke() drives the `gemini` CLI
// headlessly and maps its output to ProviderEvents; changedFiles come from `git diff` (shared util).
// enforce() maps the neutral ToolPolicy onto Gemini's approval mode + tool config.
//
// ✅ VERIFIED-AGAINST-REAL-CLI (gemini 0.49.0, 2026-06-30) — enforce-mapping. MAJOR corrections from the
// reconstructed version (all confirmed against the real `gemini --help` + reality tests):
//   (1) `--exclude-tools` DOES NOT EXIST — the real CLI exits 1 ("Unknown arguments"), so the entire
//       reconstructed tool-restriction mechanism was INVALID (it would have failed every run, loudly).
//       Replaced with `--approval-mode plan` (genuine read-only: no write/shell/web tools run) for the
//       differ roles, and `--approval-mode yolo|auto_edit` for builders.
//   (2) `--skip-trust` is now REQUIRED — gemini 0.49 refuses headless runs in an "untrusted" folder and
//       silently OVERRIDES `--approval-mode` to default without it.
//   (3) `--output-format stream-json` — structured output exists (the reconstruction assumed plain text).
//   For builders, `command-allowlist` + `network-none` are UNMET (no per-command allowlist; no simple
//   web-disable in auto-approve — the Policy Engine `--policy` is the real lever, out of scope), so the
//   router fails closed off gemini for network:none builders. changedFiles still come from host git.
// ⚠️ PARTIALLY-VERIFIED parser (DEFERRED-PENDING-INSTALL: gemini-stream-recapture): the stream-json
// ENVELOPE (`init` / `message{role,content}`) was captured from a real run, but a complete
// assistant/result event capture was blocked by gemini API 503s — the assistant/result handling below is
// INFERRED from the envelope and must be re-validated on a clean capture. auth: `oauth_creds.json` was
// stale; gemini 0.49 records the chosen auth in `settings.json` (security.auth.selectedType).
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
  // gemini 0.49 records the selected auth method in settings.json (security.auth.selectedType); older
  // builds wrote oauth_creds.json; an OAuth login leaves google_accounts.json. Any of these ⇒ configured.
  // (Heuristic: configured ≠ a valid live key — only a real invoke proves that; this is the zero-cost probe.)
  const dir = path.join(os.homedir(), '.gemini');
  for (const f of ['settings.json', 'oauth_creds.json', 'google_accounts.json']) {
    try {
      if (fs.statSync(path.join(dir, f)).size > 0) return true;
    } catch {
      /* not present — keep checking */
    }
  }
  return false;
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
  const unmet: string[] = [];
  // --skip-trust: the daemon runs gemini in a controlled worktree; WITHOUT it gemini 0.49 refuses a
  // headless run in an "untrusted" folder AND silently overrides --approval-mode. stream-json: structured.
  const args = ['--skip-trust', '--output-format', 'stream-json'];
  if (!policy.canWrite && !policy.canExecCommands) {
    // read-only (differ roles): 'plan' runs NO tools — no write, no shell, no web → network:none holds.
    args.push('--approval-mode', 'plan');
  } else {
    // builder: auto-approve within the workspace. Gemini 0.49 has NO per-command allowlist and NO simple
    // flag to disable web/shell in auto-approve (the old `--exclude-tools` is GONE; the Policy Engine
    // `--policy` is the replacement, out of scope) → those constraints are UNMET (fail closed).
    args.push('--approval-mode', policy.canExecCommands ? 'yolo' : 'auto_edit');
    if (policy.canExecCommands && policy.commandAllowlist?.length) unmet.push('command-allowlist');
    if (policy.network === 'none') unmet.push('network-none'); // web tools active in auto-approve
    if (policy.network === 'allowlist' && policy.networkAllowlist?.length)
      unmet.push('network-allowlist');
  }
  return { args, unmet };
}

interface GeminiLine {
  /** stream-json envelope: 'init' | 'message' | 'result' | 'error' (verified: init/message). */
  type?: string;
  /** 'user' (the prompt echo — skipped) | 'assistant' (the model reply). */
  role?: string;
  content?: string;
  // tolerant fallbacks (non-stream `--output-format json`, older shapes):
  response?: string;
  text?: string;
  error?: unknown;
}

/** Parse one line of `gemini --output-format stream-json`. The real envelope (VERIFIED on a live run):
 *  `{type:'init',...}`, `{type:'message', role:'user'|'assistant', content}`. The assistant reply is the
 *  `message` with role 'assistant'; the `result`/error handling is INFERRED (full capture blocked by a
 *  gemini API 503 — see header). Plain-text output (non-JSON) is surfaced as stdout. */
export function parseGeminiLine(line: string): {
  events: ProviderEvent[];
  result?: { text: string; isError: boolean };
} {
  const trimmed = line.trim();
  if (!trimmed) return { events: [] };
  let obj: GeminiLine;
  try {
    obj = JSON.parse(trimmed) as GeminiLine;
  } catch {
    // text output mode: surface the raw line as stdout.
    return { events: [{ type: 'stdout', chunk: trimmed }] };
  }
  if (obj.error || obj.type === 'error') {
    const text = obj.content ?? obj.text ?? '';
    return {
      events: text ? [{ type: 'stdout', chunk: text }] : [],
      result: { text: String(text), isError: true },
    };
  }
  if (obj.type === 'message') {
    if (obj.role === 'user') return { events: [] }; // the prompt echo — not output
    const text = obj.content ?? obj.text ?? '';
    return { events: text ? [{ type: 'stdout', chunk: text }] : [] };
  }
  if (obj.type === 'result') {
    const text = obj.content ?? obj.response ?? obj.text ?? '';
    return {
      events: text ? [{ type: 'stdout', chunk: text }] : [],
      result: { text, isError: false },
    };
  }
  // Non-stream `--output-format json` fallback: a single object with `response`.
  if (obj.response !== undefined) {
    return {
      events: obj.response ? [{ type: 'stdout', chunk: obj.response }] : [],
      result: { text: obj.response, isError: false },
    };
  }
  return { events: [] }; // 'init' + other structured lines carry no output
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  displayName: 'Gemini',
  detect: () => detectCli(GEMINI_SPEC),
  capabilities: () => ({
    canEditFiles: true,
    canRunCommands: true,
    streaming: true,
    structuredOutput: true, // verified: `--output-format stream-json` exists in gemini 0.49
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
