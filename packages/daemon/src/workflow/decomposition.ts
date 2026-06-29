// The architect's decomposition: N work items, each owning a DISJOINT set of seam paths. Treated as
// UNTRUSTED output — validated and disjointness-checked before any lane is materialized, because two
// lanes sharing files would let the path-scope audit pass writes that actually collide at merge.
import fs from 'node:fs';
import path from 'node:path';
import { THALOS_DIR_NAME } from '@thaloslab/shared';

export interface WorkItem {
  seamPaths: string[];
  summary?: string;
}

function decompositionPath(repoPath: string, ticketId: string): string {
  return path.join(repoPath, THALOS_DIR_NAME, 'artifacts', ticketId, 'decomposition.json');
}

export function writeDecomposition(repoPath: string, ticketId: string, items: WorkItem[]): void {
  const file = decompositionPath(repoPath, ticketId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items), 'utf8');
}

export function readDecomposition(repoPath: string, ticketId: string): WorkItem[] | null {
  try {
    return validate(JSON.parse(fs.readFileSync(decompositionPath(repoPath, ticketId), 'utf8')));
  } catch {
    return null;
  }
}

/** Tolerant parse of the architect's artifact: extract the first JSON array, then validate shape. */
export function parseDecomposition(raw: string): WorkItem[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) return null;
  try {
    return validate(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function validate(parsed: unknown): WorkItem[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const items: WorkItem[] = [];
  for (const x of parsed) {
    if (
      !x ||
      typeof x !== 'object' ||
      !Array.isArray((x as WorkItem).seamPaths) ||
      (x as WorkItem).seamPaths.length === 0 ||
      !(x as WorkItem).seamPaths.every((p) => typeof p === 'string' && p.length > 0)
    ) {
      return null;
    }
    items.push({ seamPaths: (x as WorkItem).seamPaths, summary: (x as WorkItem).summary });
  }
  return items;
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Untrusted-partition guard: false if any two lanes' seam paths overlap (equal or prefix-collide). */
export function seamsDisjoint(items: WorkItem[]): boolean {
  for (let i = 0; i < items.length; i++) {
    const ai = items[i];
    if (!ai) continue;
    for (let j = i + 1; j < items.length; j++) {
      const bj = items[j];
      if (!bj) continue;
      for (const a of ai.seamPaths) {
        for (const b of bj.seamPaths) {
          const na = norm(a);
          const nb = norm(b);
          if (na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)) return false;
        }
      }
    }
  }
  return true;
}

/** Changed files that fall OUTSIDE the lane's declared seam (a path-ownership breach). */
export function outOfSeam(changedFiles: string[], seamPaths: string[]): string[] {
  const seams = seamPaths.map(norm);
  return changedFiles.filter((cf) => {
    const f = norm(cf);
    return !seams.some((s) => f === s || f.startsWith(`${s}/`));
  });
}
