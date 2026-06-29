// Claude Code adapter. Phase 0 implements detect() + capabilities() only; invoke() is a typed
// stub that throws until Phase 1. detect() NEVER spends tokens (SPEC §5, DECISIONS #17):
// PATH/version probe + a filesystem-only credentials check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type {
  DetectResult,
  InvokeOptions,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
} from '@thaloslab/shared';
import { whichSync } from './which';

const CLAUDE_BIN = 'claude';

/** Zero-cost auth signal: stored OAuth credentials or an API key in the environment. */
function checkClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).size > 0) return true;
    } catch {
      // not present — keep checking
    }
  }
  return false;
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
      // Installed but the version probe failed — still report installed.
    }

    return { installed: true, authenticated: checkClaudeAuth(), version };
  },

  capabilities(): ProviderCapabilities {
    return { canEditFiles: true, canRunCommands: true, streaming: true, structuredOutput: true };
  },

  invoke(_opts: InvokeOptions): AsyncIterable<ProviderEvent> {
    throw new Error('claude.invoke not implemented (Phase 1)');
  },
};
