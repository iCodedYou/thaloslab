import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InvokeOptions, ProviderEvent } from '@thaloslab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mockAdapter, resetMock, setMockProgram } from './mock';

function opts(cwd: string): InvokeOptions {
  return {
    prompt: 'do the thing',
    cwd,
    mode: 'mock',
    policy: {
      canRead: true,
      canWrite: true,
      canExecCommands: false,
      network: 'none',
      pathScope: 'own-worktree',
    },
  };
}

async function collect(cwd: string): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of mockAdapter.invoke(opts(cwd))) events.push(e);
  return events;
}

afterEach(() => resetMock());

describe('mock provider', () => {
  it('writes scripted files into cwd and reports them in the result', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-mock-'));
    setMockProgram(() => ({ ok: true, writeFiles: { 'src/fix.ts': 'export const x = 1;\n' } }));
    const events = await collect(cwd);

    expect(fs.readFileSync(path.join(cwd, 'src/fix.ts'), 'utf8')).toContain('export const x');
    const result = events.at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.result.ok).toBe(true);
      expect(result.result.changedFiles).toContain('src/fix.ts');
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('emits the expected event sequence (status → tool → stdout → result)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-mock-'));
    setMockProgram(() => ({ ok: true, writeFiles: { 'a.ts': '1' } }));
    const types = (await collect(cwd)).map((e) => e.type);
    expect(types[0]).toBe('status');
    expect(types).toContain('tool');
    expect(types.at(-1)).toBe('result');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('an off-allowlist tool denial yields a not-ok result', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-mock-'));
    setMockProgram(() => ({ ok: true, toolDenied: 'Bash(curl *)' }));
    const events = await collect(cwd);
    const result = events.at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.result.ok).toBe(false);
      expect(result.result.output).toContain('denied');
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('passes call index so a program can script fail-then-succeed', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-mock-'));
    setMockProgram((_o, i) => ({ ok: i > 0, output: i > 0 ? 'fixed' : 'still broken' }));
    const first = (await collect(cwd)).at(-1);
    const second = (await collect(cwd)).at(-1);
    if (first?.type === 'result') expect(first.result.ok).toBe(false);
    if (second?.type === 'result') expect(second.result.ok).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
