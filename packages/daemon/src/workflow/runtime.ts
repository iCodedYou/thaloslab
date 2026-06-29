// The daemon's engine runtime: one EventBus + one Engine shared across REST routes and the WS hub.
// The StageRunner is injectable so tests drive a scripted runner; production composes the real one.
import { type Engine, type StageRunner, createEngine } from './engine';
import { EventBus } from './events';
import { createProductionStageRunner } from './stage-runner';
import { bugFixTemplate, templateById } from './templates';

export interface Runtime {
  engine: Engine;
  bus: EventBus;
}

export interface RuntimeOptions {
  /** Injected for tests; defaults to the production StageRunner. */
  stageRunner?: StageRunner;
  now?: () => number;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const bus = new EventBus();
  const stageRunner = opts.stageRunner ?? createProductionStageRunner({ bus, now: opts.now });
  const engine = createEngine({
    stageRunner,
    resolveTemplate: (ticket) => templateById(ticket.workflowId ?? '') ?? bugFixTemplate,
    bus,
    now: opts.now,
  });
  return { engine, bus };
}
