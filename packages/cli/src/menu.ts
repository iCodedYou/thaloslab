// Interactive launcher menu (SPEC §13). Phase 0: pick execution mode + collab, then launch.
import * as p from '@clack/prompts';
import type { ExecutionMode } from '@thaloslab/shared';

export interface MenuChoices {
  mode: ExecutionMode;
  collab: boolean;
}

export async function runMenu(defaults: Partial<MenuChoices>): Promise<MenuChoices | null> {
  p.intro('Thalos Lab');

  const mode = await p.select<ExecutionMode>({
    message: 'Execution mode',
    initialValue: defaults.mode ?? 'preview',
    options: [
      { value: 'preview', label: 'Preview', hint: 'real planning, no repo writes (default)' },
      { value: 'live', label: 'Live', hint: 'real agents, real changes' },
      { value: 'mock', label: 'Mock', hint: 'dev-only stubbed providers' },
    ],
  });
  if (p.isCancel(mode)) {
    p.cancel('Cancelled');
    return null;
  }

  const collab = await p.confirm({
    message: 'Enable collab pooling?',
    initialValue: defaults.collab ?? false,
  });
  if (p.isCancel(collab)) {
    p.cancel('Cancelled');
    return null;
  }

  return { mode, collab };
}
