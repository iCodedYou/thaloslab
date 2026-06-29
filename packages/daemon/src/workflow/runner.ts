// executeRun — consume a provider invocation's event stream into a persisted `runs` row, emit
// live agent.output events, and return the outcome. The runs row is inserted BEFORE consuming the
// stream (authoritative in-flight marker for crash recovery) and finalized after.
import type { InvokeOptions, ProviderAdapter, ProviderId } from '@thaloslab/shared';
import { insertRun, updateRun } from '../store/repositories/runs';
import { genId } from '../util/id';
import type { EventBus } from './events';
import { errorSignature } from './stuck';

export interface RunOutcome {
  runId: string;
  ok: boolean;
  output: string;
  changedFiles: string[];
  errorSignature?: string;
}

export interface RunContext {
  ticketId: string;
  taskId: string;
  agentId?: string;
  /** The LOGICAL provider the router resolved (recorded on the run). In `--mock` the actual adapter
   *  is the mock, but the run still records this resolved provider so routing is auditable/testable. */
  provider: ProviderId;
  /** The assembly-preferred provider, if it differed from the resolved one (audit trail). */
  requestedProvider?: ProviderId;
  bus: EventBus;
  now: () => number;
}

export async function executeRun(
  provider: ProviderAdapter,
  opts: InvokeOptions,
  ctx: RunContext,
): Promise<RunOutcome> {
  const runId = genId('run');
  // In-flight marker BEFORE the side-effecting invocation (recovery reaps this if we crash). Record
  // the LOGICAL resolved provider (ctx.provider), not the adapter id (which is 'mock' in --mock).
  insertRun({
    id: runId,
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    provider: ctx.provider,
    requestedProvider: ctx.requestedProvider,
    prompt: opts.prompt,
    status: 'running',
    startedAt: ctx.now(),
  });

  let output = '';
  let resultOk = false;
  let changedFiles: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let costUsd: number | undefined;

  for await (const event of provider.invoke(opts)) {
    if (event.type === 'stdout' || event.type === 'stderr') output += event.chunk;
    if (event.type === 'result') {
      resultOk = event.result.ok;
      changedFiles = event.result.changedFiles;
      inputTokens = event.result.usage?.inputTokens;
      outputTokens = event.result.usage?.outputTokens;
      costUsd = event.result.usage?.costUsd;
    }
    ctx.bus.emit({
      ticketId: ctx.ticketId,
      taskId: ctx.taskId,
      type: 'agent.output',
      payload: { runId, event },
    });
  }

  const sig = resultOk ? undefined : errorSignature(output || 'unknown failure');
  updateRun(runId, {
    status: resultOk ? 'ok' : 'error',
    output,
    changedFiles,
    errorSignature: sig,
    inputTokens,
    outputTokens,
    costUsd,
    endedAt: ctx.now(),
  });

  return { runId, ok: resultOk, output, changedFiles, errorSignature: sig };
}
