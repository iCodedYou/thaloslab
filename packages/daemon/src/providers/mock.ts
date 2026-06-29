// Scripted mock provider for `--mock` and deterministic engine tests. Mirrors the real claude
// invoke() contract (streams ProviderEvents, final result carries InvokeResult) but spends zero
// tokens. A test/run sets a `MockProgram` deciding each invocation's behavior — succeed, fail,
// repeat-an-error, write files (real writes in cwd, so gates + git diff see them), simulate a
// long run (crash tests) or an off-allowlist tool denial.
import fs from 'node:fs';
import path from 'node:path';
import type {
  InvokeOptions,
  InvokeResult,
  ProviderAdapter,
  ProviderEvent,
} from '@thaloslab/shared';

export interface MockBehavior {
  ok: boolean;
  output?: string;
  /** Relative path -> content; written for real into opts.cwd so gates/git observe the change. */
  writeFiles?: Record<string, string>;
  deleteFiles?: string[];
  /** Simulate a permission denial for an off-allowlist tool → run is not ok. */
  toolDenied?: string;
  /** Simulate a long-running invocation (for crash/interrupt tests). */
  delayMs?: number;
  tokens?: { input: number; output: number };
  costUsd?: number;
  /** Override the emitted event stream entirely. */
  events?: ProviderEvent[];
}

export type MockProgram = (opts: InvokeOptions, callIndex: number) => MockBehavior;

const DEFAULT_PROGRAM: MockProgram = () => ({ ok: true, output: 'mock ok' });
let program: MockProgram = DEFAULT_PROGRAM;
let callIndex = 0;

export function setMockProgram(p: MockProgram): void {
  program = p;
  callIndex = 0;
}

export function resetMock(): void {
  program = DEFAULT_PROGRAM;
  callIndex = 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const mockAdapter: ProviderAdapter = {
  id: 'mock',
  displayName: 'Mock Provider',
  detect: () => Promise.resolve({ installed: true, authenticated: true, version: 'mock-1' }),
  capabilities: () => ({
    canEditFiles: true,
    canRunCommands: true,
    streaming: true,
    structuredOutput: true,
  }),
  // The mock can express any policy (it's not a real CLI) → nothing unmet. The mirroring
  // mock-codex/mock-gemini adapters (3c) override this to simulate real provider limits.
  enforce: () => ({ args: [], unmet: [] }),
  async *invoke(opts: InvokeOptions): AsyncIterable<ProviderEvent> {
    const behavior = program(opts, callIndex++);
    yield { type: 'status', status: 'started' };
    if (behavior.delayMs) await sleep(behavior.delayMs);

    const changed: string[] = [];
    for (const [rel, content] of Object.entries(behavior.writeFiles ?? {})) {
      const abs = path.join(opts.cwd, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      changed.push(rel);
      yield { type: 'tool', name: 'Write', detail: rel };
    }
    for (const rel of behavior.deleteFiles ?? []) {
      try {
        fs.unlinkSync(path.join(opts.cwd, rel));
        changed.push(rel);
      } catch {
        /* already gone */
      }
    }
    for (const e of behavior.events ?? []) yield e;

    const ok = behavior.ok && !behavior.toolDenied;
    const output = behavior.toolDenied
      ? `permission denied for tool: ${behavior.toolDenied}`
      : (behavior.output ?? (ok ? 'mock ok' : 'mock fail'));
    yield { type: 'stdout', chunk: output };

    const result: InvokeResult = {
      ok,
      output,
      artifacts: [],
      changedFiles: changed,
      usage: {
        inputTokens: behavior.tokens?.input ?? 1,
        outputTokens: behavior.tokens?.output ?? 1,
        costUsd: behavior.costUsd ?? 0,
      },
      raw: { mock: true, behavior },
    };
    yield { type: 'result', result };
  },
};
