// Triage / classification (SPEC §7). A single mockable LLM classification with a deterministic
// keyword fallback, so preview/mock runs are reproducible. Output selects the workflow template
// and the blast radius that decides mandatory gates.
import type { TaskType } from '@thaloslab/shared';

export interface TriageResult {
  taskType: TaskType;
  mutating: boolean;
  /** Sensitive surfaces touched (auth/payments/data/infra) → mandatory security pass + deploy gate. */
  blastRadius: string[];
}

const SENSITIVE: Array<{ kw: string[]; surface: string }> = [
  { kw: ['auth', 'login', 'oauth', 'session', 'password', 'token', 'sso'], surface: 'auth' },
  { kw: ['payment', 'billing', 'charge', 'stripe', 'invoice', 'checkout'], surface: 'payments' },
  { kw: ['migration', 'schema', 'database', 'sql'], surface: 'data' },
  { kw: ['deploy', 'infra', 'kubernetes', 'k8s', 'terraform', 'pipeline'], surface: 'infra' },
];

const TYPE_KEYWORDS: Array<{ kw: string[]; type: TaskType; mutating: boolean }> = [
  {
    kw: ['bug', 'fix', '500', 'error', 'crash', 'broken', 'fails', 'regression', 'throws', 'wrong'],
    type: 'bugfix',
    mutating: true,
  },
  {
    kw: ['audit', 'security', 'vulnerab', 'cve', 'exploit'],
    type: 'security-audit',
    mutating: false,
  },
  { kw: ['refactor', 'cleanup', 'restructure', 'rename'], type: 'refactor', mutating: true },
  {
    kw: ['optimi', 'perf', 'slow', 'latency', 'benchmark', 'faster'],
    type: 'optimization',
    mutating: true,
  },
  { kw: ['redesign', 'restyle', 'layout', 'css', 'visual'], type: 'redesign', mutating: true },
  { kw: ['document', 'readme', 'docs'], type: 'docs', mutating: true },
  {
    kw: ['investigate', 'diagnose', 'root cause', 'why is'],
    type: 'investigation',
    mutating: false,
  },
  { kw: ['feature', 'add ', 'implement', 'support for', 'new '], type: 'feature', mutating: true },
];

export function keywordTriage(title: string, body = ''): TriageResult {
  const text = `${title} ${body}`.toLowerCase();
  const match = TYPE_KEYWORDS.find(({ kw }) => kw.some((k) => text.includes(k)));
  const blastRadius = SENSITIVE.filter((s) => s.kw.some((k) => text.includes(k))).map(
    (s) => s.surface,
  );
  return {
    taskType: match?.type ?? 'bugfix',
    mutating: match?.mutating ?? true,
    blastRadius,
  };
}

/** Optional LLM-backed classifier (mockable). Returning null falls back to keyword triage. */
export type Classifier = (title: string, body: string) => Promise<TriageResult | null>;

export async function classifyTicket(
  title: string,
  body = '',
  classifier?: Classifier,
): Promise<TriageResult> {
  if (classifier) {
    try {
      const result = await classifier(title, body);
      if (result) return result;
    } catch {
      // Classification failure → deterministic keyword fallback (preview must still run for real).
    }
  }
  return keywordTriage(title, body);
}
