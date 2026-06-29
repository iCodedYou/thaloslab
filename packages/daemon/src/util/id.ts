import { randomUUID } from 'node:crypto';

/** Short, prefixed, collision-resistant id, e.g. `p_3f9a1c2b7e04`. */
export function genId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
