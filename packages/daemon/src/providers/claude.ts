// Claude Code adapter. detect()/capabilities()/enforce() are zero-cost (SPEC §5, DECISIONS #17).
// enforce() translates the neutral ToolPolicy into Claude's per-tool allowlist/denylist — Claude is
// the capability baseline (it can express read/write/exec/per-command-allowlist/denylist/network-via-
// tool-deny), so its `unmet` is always empty. invoke() drives `claude -p --output-format stream-json`,
// parsing line-delimited JSON into ProviderEvents; changedFiles come from `git diff` (shared util, we
// don't trust self-reports). A version guard warns when the CLI is outside the tested range.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EnforceResult,
  InvokeOptions,
  InvokeResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ToolPolicy,
} from '@thaloslab/shared';
import { changedFiles } from '../util/git';
import { lines } from '../util/stream';
import { type CliSpec, detectCli, guardVersion } from './detect-cli';
import { spawnSandboxed } from './sandbox/spawn';
import { whichSync } from './which';

const CLAUDE_BIN = 'claude';
const TESTED_VERSION_PREFIX = '2.1.';

function checkClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const home = os.homedir();
  for (const candidate of [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ]) {
    try {
      if (fs.statSync(candidate).size > 0) return true;
    } catch {
      /* keep checking */
    }
  }
  return false;
}

const CLAUDE_SPEC: CliSpec = {
  bin: CLAUDE_BIN,
  versionArgs: ['--version'],
  authCheck: checkClaudeAuth,
  testedPrefix: TESTED_VERSION_PREFIX,
  label: 'claude',
};

/** Translate the neutral policy to Claude's `--allowedTools` / `--disallowedTools`. */
function enforce(policy: ToolPolicy): EnforceResult {
  const allowed: string[] = [];
  if (policy.canRead) allowed.push('Read');
  if (policy.canWrite) allowed.push('Write', 'Edit');
  if (policy.canExecCommands) {
    if (policy.commandAllowlist?.length) {
      for (const p of policy.commandAllowlist) allowed.push(`Bash(${p})`);
    } else {
      allowed.push('Bash');
    }
  }
  const denied = (policy.commandDenylist ?? []).map((d) => `Bash(${d})`);
  if (policy.network === 'none') denied.push('WebFetch', 'WebSearch');

  const args: string[] = [];
  if (allowed.length) args.push('--allowedTools', allowed.join(' '));
  if (denied.length) args.push('--disallowedTools', denied.join(' '));
  // Claude can express every constraint in ToolPolicy → nothing unmet.
  return { args, unmet: [] };
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface StreamLine {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  displayName: 'Claude Code',

  detect: () => detectCli(CLAUDE_SPEC),

  capabilities(): ProviderCapabilities {
    return { canEditFiles: true, canRunCommands: true, streaming: true, structuredOutput: true };
  },

  enforce,

  async *invoke(opts: InvokeOptions): AsyncIterable<ProviderEvent> {
    const resolved = whichSync(CLAUDE_BIN);
    if (!resolved) {
      yield {
        type: 'result',
        result: {
          ok: false,
          output: 'claude CLI not found',
          artifacts: [],
          changedFiles: [],
          raw: {},
        },
      };
      return;
    }
    await guardVersion(resolved, TESTED_VERSION_PREFIX, 'claude');

    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      'acceptEdits', // auto-accept edits; off-allowlist tools are denied (surface as gate failure)
      '--no-session-persistence',
      '--max-turns',
      '30',
      ...enforce(opts.policy).args,
    ];
    if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
    if (opts.model) args.push('--model', opts.model);

    yield { type: 'status', status: 'invoking claude' };
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

    let resultText = '';
    let isError = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let costUsd: number | undefined;

    const handleLine = (line: string): ProviderEvent[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let obj: StreamLine;
      try {
        obj = JSON.parse(trimmed) as StreamLine;
      } catch {
        return []; // tolerant: ignore non-JSON / partial lines, never crash the run
      }
      const events: ProviderEvent[] = [];
      if (obj.type === 'system') {
        events.push({ type: 'status', status: obj.subtype ?? 'system' });
      } else if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text)
            events.push({ type: 'stdout', chunk: block.text });
          if (block.type === 'tool_use' && block.name)
            events.push({ type: 'tool', name: block.name });
        }
      } else if (obj.type === 'result') {
        isError = obj.is_error ?? obj.subtype !== 'success';
        resultText = obj.result ?? '';
        inputTokens = obj.usage?.input_tokens;
        outputTokens = obj.usage?.output_tokens;
        costUsd = obj.total_cost_usd;
      }
      return events;
    };

    if (child.stdout) {
      for await (const line of lines(child.stdout)) {
        for (const e of handleLine(line)) yield e;
      }
    }

    const final = await child;
    const files = await changedFiles(opts.cwd);
    const ok = !isError && (final.exitCode ?? 0) === 0;
    const result: InvokeResult = {
      ok,
      output: resultText,
      artifacts: [],
      changedFiles: files,
      usage: { inputTokens, outputTokens, costUsd },
      raw: { exitCode: final.exitCode, timedOut: final.timedOut },
    };
    yield { type: 'result', result };
  },
};
