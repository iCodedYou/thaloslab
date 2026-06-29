export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'dim';

export const TASK_TONE: Record<string, Tone> = {
  pending: 'dim',
  running: 'accent',
  review: 'accent',
  fixing: 'warn',
  'blocked-on-human': 'warn',
  passed: 'ok',
  done: 'ok',
  failed: 'danger',
  escalated: 'danger',
};

export const TICKET_TONE: Record<string, Tone> = {
  queued: 'dim',
  running: 'accent',
  blocked: 'warn',
  'preview-complete': 'accent',
  done: 'ok',
  failed: 'danger',
  escalated: 'danger',
  aborted: 'danger',
};

export const DOT_CLASS: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  accent: 'bg-accent',
  dim: 'bg-faint',
};

export const TEXT_CLASS: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  accent: 'text-accent',
  dim: 'text-faint',
};
