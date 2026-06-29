// Claude Code adapter. detect()/capabilities() are zero-cost (SPEC §5, DECISIONS #17). invoke()
// drives `claude` headlessly: `-p --output-format stream-json` with role/permission/tool flags,
// parsing the line-delimited JSON into ProviderEvents. changedFiles come from `git diff` in the
// worktree (we don't trust the model's self-report). A timeout backstops any hang, and a version
// guard warns loudly when the installed CLI is outside the tested range.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type {
  DetectResult,
  InvokeOptions,
  InvokeResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
} from '@thaloslab/shared';
import { whichSync } from './which';

const CLAUDE_BIN = 'claude';
/** CLI version range this adapter was written and tested against (SPEC §5 — verify at build time). */
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

let versionChecked = false;
async function guardVersion(bin: string): Promise<void> {
  if (versionChecked) return;
  versionChecked = true;
  try {
    const { stdout } = await execa(bin, ['--version'], { timeout: 10_000 });
    const version = stdout.trim().split(/\s+/)[0] ?? '';
    if (!version.startsWith(TESTED_VERSION_PREFIX)) {
      // Loud warning (configurable-fail): the stream-json line protocol can drift across versions.
      process.stderr.write(
        `[thalos] WARNING: claude CLI ${version} is outside the tested range ${TESTED_VERSION_PREFIX}x — ` +
          `stream-json parsing may drift. Set THALOS_STRICT_CLI_VERSION=1 to fail instead.\n`,
      );
      if (process.env.THALOS_STRICT_CLI_VERSION === '1') {
        throw new Error(`claude CLI ${version} outside tested range ${TESTED_VERSION_PREFIX}x`);
      }
    }
  } catch (err) {
    if (process.env.THALOS_STRICT_CLI_VERSION === '1') throw err;
  }
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

async function gitChangedFiles(cwd: string): Promise<string[]> {
  try {
    const tracked = await execa('git', ['diff', '--name-only'], { cwd, reject: false });
    const untracked = await execa('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      reject: false,
    });
    const set = new Set(
      `${tracked.stdout}\n${untracked.stdout}`
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    return [...set];
  } catch {
    return [];
  }
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  displayName: 'Claude Code',

  async detect(): Promise<DetectResult> {
    const resolved = whichSync(CLAUDE_BIN);
    if (!resolved) return { installed: false, authenticated: false };
    let version: string | undefined;
    try {
      const { stdout } = await execa(resolved, ['--version'], { timeout: 10_000 });
      version = stdout.trim().split('\n')[0]?.trim();
    } catch {
      /* installed but version probe failed */
    }
    return { installed: true, authenticated: checkClaudeAuth(), version };
  },

  capabilities(): ProviderCapabilities {
    return { canEditFiles: true, canRunCommands: true, streaming: true, structuredOutput: true };
  },

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
    await guardVersion(resolved);

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
    ];
    if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
    if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(' '));
    if (opts.deniedCommands?.length) args.push('--disallowedTools', opts.deniedCommands.join(' '));
    if (opts.model) args.push('--model', opts.model);

    yield { type: 'status', status: 'invoking claude' };
    const child = execa(resolved, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 300_000,
      reject: false,
      buffer: false,
      stripFinalNewline: false,
    });

    let resultText = '';
    let isError = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let costUsd: number | undefined;
    let buf = '';

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
          if (block.type === 'tool_use' && block.name) {
            events.push({ type: 'tool', name: block.name });
          }
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
      for await (const chunk of child.stdout) {
        buf += (chunk as Buffer).toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          for (const e of handleLine(line)) yield e;
        }
      }
    }
    for (const e of handleLine(buf)) yield e;

    const final = await child;
    const changedFiles = await gitChangedFiles(opts.cwd);
    const ok = !isError && (final.exitCode ?? 0) === 0;
    const result: InvokeResult = {
      ok,
      output: resultText,
      artifacts: [],
      changedFiles,
      usage: { inputTokens, outputTokens, costUsd },
      raw: { exitCode: final.exitCode, timedOut: final.timedOut },
    };
    yield { type: 'result', result };
  },
};
