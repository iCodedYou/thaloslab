// Worktree isolation (SPEC §9). Each task runs in its own git worktree on a task branch off a
// dedicated `thalos/integration` staging branch — NEVER the repo's default branch (DECISIONS:
// landing on main is a separate human action). Includes the post-run path-scope audit (the real
// backstop until the Phase 5 sandbox) and Windows-tolerant teardown.
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { THALOS_DIR_NAME, THALOS_WORKTREES_DIR } from '@thaloslab/shared';

export const INTEGRATION_BRANCH = 'thalos/integration';

export interface Worktree {
  taskId: string;
  path: string;
  branch: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function worktreeDir(repoPath: string, name: string): string {
  return path.join(repoPath, THALOS_DIR_NAME, THALOS_WORKTREES_DIR, name);
}

/** Ensure the staging integration branch exists (off the current default HEAD). Never edits main. */
export async function ensureIntegrationBranch(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath);
  const branches = await git.branchLocal();
  if (!branches.all.includes(INTEGRATION_BRANCH)) {
    await git.raw(['branch', INTEGRATION_BRANCH]); // off current HEAD
  }
}

export async function createWorktree(repoPath: string, taskId: string): Promise<Worktree> {
  await ensureIntegrationBranch(repoPath);
  const branch = `thalos/task-${taskId}`;
  const wtPath = worktreeDir(repoPath, `task-${taskId}`);
  // New task branch + worktree off the integration branch (not the default branch).
  await simpleGit(repoPath).raw(['worktree', 'add', '-b', branch, wtPath, INTEGRATION_BRANCH]);
  // EOL hardening — fix the cause, since changedFiles feeds the no-progress heuristic:
  //   (layer 1, source) a worktree-local .gitattributes makes git normalize line endings in diffs,
  //   so a Windows CRLF checkout no longer shows every file as modified. Combined with
  //   core.autocrlf=false and the --ignore-cr-at-eol diff in util/git.ts (layer 2).
  await simpleGit(wtPath).addConfig('core.autocrlf', 'false', false, 'local');
  fs.writeFileSync(path.join(wtPath, '.gitattributes'), '* text=auto eol=lf\n', 'utf8');
  return { taskId, path: wtPath, branch };
}

export interface ScopeAudit {
  ok: boolean;
  offending: string[];
}

/**
 * Post-run path-scope audit: the agent worked in its task worktree (separate working dir), so the
 * MAIN worktree must be clean. Any change there (outside the managed `.thalos/`) means the agent
 * escaped its worktree — fail the run as a scope breach. (Writes entirely outside the repo are not
 * git-visible; the tool allowlist + permission-mode are the guard there until the Phase 5 sandbox.)
 */
export async function auditScope(repoPath: string): Promise<ScopeAudit> {
  const status = await simpleGit(repoPath).raw(['status', '--porcelain']);
  const offending = status
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^.{1,2}\s+/, '').replace(/^"|"$/g, ''))
    .filter((p) => !p.startsWith(`${THALOS_DIR_NAME}/`));
  return { ok: offending.length === 0, offending };
}

/** Diff of a task branch vs the integration branch — retained as a `diff` artifact. */
export async function captureDiff(repoPath: string, branch: string): Promise<string> {
  return simpleGit(repoPath).raw(['diff', `${INTEGRATION_BRANCH}...${branch}`]);
}

/** A persistent worktree checked out on the integration branch, used to merge into it. */
export async function ensureIntegrationWorktree(repoPath: string): Promise<string> {
  await ensureIntegrationBranch(repoPath);
  const wtPath = worktreeDir(repoPath, 'integration');
  if (!fs.existsSync(wtPath)) {
    await simpleGit(repoPath).raw(['worktree', 'add', wtPath, INTEGRATION_BRANCH]);
  }
  return wtPath;
}

/** Merge a task branch into `thalos/integration` (never the default branch). */
export async function integrate(
  repoPath: string,
  branch: string,
): Promise<{ ok: boolean; output: string }> {
  const wt = await ensureIntegrationWorktree(repoPath);
  try {
    const out = await simpleGit(wt).raw(['merge', '--no-edit', branch]);
    return { ok: true, output: out };
  } catch (err) {
    // Conflict or merge failure — leave it for inspection; abort to keep integration clean.
    try {
      await simpleGit(wt).raw(['merge', '--abort']);
    } catch {
      /* nothing to abort */
    }
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove a task worktree (retaining its branch + diff). Windows holds file handles (subprocess,
 * AV, watchers) so removal can EPERM/EBUSY — bounded retry, then a manual rm + prune fallback.
 * Never throws: the branch is retained regardless, so teardown failure must not block the ticket.
 */
export async function teardownWorktree(
  repoPath: string,
  wt: Worktree,
): Promise<{ removed: boolean; error?: string }> {
  const git = simpleGit(repoPath);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await git.raw(['worktree', 'remove', '--force', wt.path]);
      await git.raw(['worktree', 'prune']);
      return { removed: true };
    } catch (err) {
      lastErr = err;
      await sleep(150 * (attempt + 1));
    }
  }
  try {
    fs.rmSync(wt.path, { recursive: true, force: true });
    await git.raw(['worktree', 'prune']);
    return { removed: true };
  } catch {
    return { removed: false, error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
  }
}
