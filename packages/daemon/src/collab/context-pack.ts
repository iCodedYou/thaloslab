// The context pack the host sends a peer (DECISIONS #8): allowlist-first (the architect's read-only
// pack + the task worktree subset — NEVER whole-repo by default), the secret deny-net + content scan
// as a second net, and a HOST-VISIBLE MANIFEST (path + content hash of exactly what crossed). A
// surviving secret ABORTS the build — the host never sends-and-warns. This is the only lever on the
// one-way data-confidentiality axis: minimize what crosses + inform the host precisely what did.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SecretLeakError, isDeniedPath, scanSecrets } from './secrets';

export interface ManifestEntry {
  path: string; // POSIX-relative
  sha256: string;
  bytes: number;
}
export interface ContextPack {
  files: { path: string; content: string }[];
  manifest: ManifestEntry[];
  excluded: string[]; // denied files that were dropped (visible to the host, not sent)
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.thalos', 'dist', '.next', 'coverage']);

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(root, r));
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

/**
 * Build the pack from `rootDir`. With an `allowlist` (relative paths), ONLY those files are
 * candidates (whole-repo is opt-in by passing the full walk). Denied files are dropped (recorded in
 * `excluded`); any candidate whose CONTENT carries a secret shape ABORTS the build (SecretLeakError)
 * — stripping inline secrets is unreliable, so the host refuses to share that file at all.
 */
export function buildContextPack(
  rootDir: string,
  opts: { allowlist?: string[] } = {},
): ContextPack {
  const candidates = (opts.allowlist ?? walk(rootDir)).map((p) => p.replace(/\\/g, '/'));
  const files: ContextPack['files'] = [];
  const manifest: ManifestEntry[] = [];
  const excluded: string[] = [];
  for (const rel of candidates) {
    if (isDeniedPath(rel)) {
      excluded.push(rel); // deny-net: never crosses; the host sees it was withheld
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    } catch {
      continue;
    }
    const hits = scanSecrets(content);
    if (hits.length > 0) throw new SecretLeakError(rel, hits); // REFUSE — never warn-and-send
    files.push({ path: rel, content });
    manifest.push({
      path: rel,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    });
  }
  return { files, manifest, excluded };
}
