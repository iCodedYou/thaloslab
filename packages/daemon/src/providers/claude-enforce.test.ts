// claudeAdapter.enforce translates the neutral ToolPolicy into Claude's per-tool allow/deny flags.
// Claude is the capability baseline → `unmet` is always empty.
import type { ToolPolicy } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude';

const policy = (over: Partial<ToolPolicy>): ToolPolicy => ({
  canRead: true,
  canWrite: false,
  canExecCommands: false,
  network: 'none',
  pathScope: 'own-worktree',
  ...over,
});

describe('claude enforce(policy)', () => {
  it('read-only role → only Read is allowed', () => {
    const { args, unmet } = claudeAdapter.enforce(policy({}));
    const allowed = args[args.indexOf('--allowedTools') + 1];
    expect(allowed).toBe('Read');
    expect(unmet).toEqual([]);
  });

  it('builder → Read/Write/Edit + a Bash() per allowlist pattern', () => {
    const { args } = claudeAdapter.enforce(
      policy({ canWrite: true, canExecCommands: true, commandAllowlist: ['git *', 'pnpm *'] }),
    );
    const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
    expect(allowed).toContain('Write');
    expect(allowed).toContain('Bash(git *)');
    expect(allowed).toContain('Bash(pnpm *)');
  });

  it('network:none denies WebFetch/WebSearch; denylist maps to Bash() denials', () => {
    const { args } = claudeAdapter.enforce(
      policy({ network: 'none', commandDenylist: ['rm -rf *', 'curl *'] }),
    );
    const denied = args[args.indexOf('--disallowedTools') + 1] ?? '';
    expect(denied).toContain('WebFetch');
    expect(denied).toContain('Bash(rm -rf *)');
  });

  it('Claude can express every constraint → unmet is always empty', () => {
    expect(
      claudeAdapter.enforce(
        policy({ canWrite: true, canExecCommands: true, commandAllowlist: ['git *'] }),
      ).unmet,
    ).toEqual([]);
  });
});
