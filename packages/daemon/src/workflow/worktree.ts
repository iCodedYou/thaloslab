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
  /** The lane this worktree belongs to. Sequential stages share a lane; fan-out children differ. */
  laneId: string;
  path: string;
  branch: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function worktreeDir(repoPath: string, name: string): string {
  return path.join(repoPath, THALOS_DIR_NAME, THALOS_WORKTREES_DIR, name);
}

/** laneId contains ':' (invalid in branch names / paths) — slug it for git + the filesystem. */
function laneSlug(laneId: string): string {
  return laneId.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Ensure the staging integration branch exists (off the current default HEAD). Never edits main. */
export async function ensureIntegrationBranch(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath);
  const branches = await git.branchLocal();
  if (!branches.all.includes(INTEGRATION_BRANCH)) {
    await git.raw(['branch', INTEGRATION_BRANCH]); // off current HEAD
  }
}

/**
 * Create (or ADOPT) a lane's worktree + branch off `thalos/integration` (never the default branch).
 * Idempotent: on crash recovery the worktree may survive on disk/git though the in-memory Map was
 * lost, so we adopt an existing dir, or re-add a worktree on an existing branch, rather than throwing.
 */
export async function createWorktree(repoPath: string, laneId: string): Promise<Worktree> {
  await ensureIntegrationBranch(repoPath);
  const slug = laneSlug(laneId);
  const branch = `thalos/lane-${slug}`;
  const wtPath = worktreeDir(repoPath, `lane-${slug}`);
  const git = simpleGit(repoPath);

  if (!fs.existsSync(wtPath)) {
    const branches = await git.branchLocal();
    const args = branches.all.includes(branch)
      ? ['worktree', 'add', wtPath, branch] // branch survived a crash; re-attach a worktree
      : ['worktree', 'add', '-b', branch, wtPath, INTEGRATION_BRANCH];
    await git.raw(args);
  }
  // EOL hardening — fix the cause, since changedFiles feeds the no-progress heuristic:
  //   (layer 1, source) a worktree-local .gitattributes makes git normalize line endings in diffs,
  //   so a Windows CRLF checkout no longer shows every file as modified. Combined with
  //   core.autocrlf=false and the --ignore-cr-at-eol diff in util/git.ts (layer 2).
  await simpleGit(wtPath).addConfig('core.autocrlf', 'false', false, 'local');
  const gitattrs = path.join(wtPath, '.gitattributes');
  if (!fs.existsSync(gitattrs)) fs.writeFileSync(gitattrs, '* text=auto eol=lf\n', 'utf8');
  return { laneId, path: wtPath, branch };
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

/** Merge a task branch into `thalos/integration` (never the default branch). Aborts on conflict —
 *  the simple primitive used where conflict ORCHESTRATION isn't wanted. */
export async function integrate(
  repoPath: string,
  branch: string,
): Promise<{ ok: boolean; output: string }> {
  const wt = await ensureIntegrationWorktree(repoPath);
  try {
    const out = await simpleGit(wt).raw(['merge', '--no-edit', branch]);
    return { ok: true, output: out };
  } catch (err) {
    try {
      await simpleGit(wt).raw(['merge', '--abort']);
    } catch {
      /* nothing to abort */
    }
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/** Low-level merge that LEAVES a conflict in place (no auto-abort) so the integrator can detect and
 *  resolve it. `conflicted` is true when the merge stopped on conflicts. */
export async function mergeInto(
  integDir: string,
  branch: string,
): Promise<{ ok: boolean; conflicted: boolean; output: string }> {
  // git merge exits non-zero on conflict, but simple-git's raw() doesn't always throw — so the
  // authoritative conflict signal is the unmerged (U) status afterwards, not a thrown error.
  let output = '';
  try {
    output = await simpleGit(integDir).raw(['merge', '--no-edit', branch]);
  } catch (err) {
    output = err instanceof Error ? err.message : String(err);
  }
  const conflicts = await detectConflicts(integDir);
  return { ok: conflicts.length === 0, conflicted: conflicts.length > 0, output };
}

/** Files with unresolved merge conflicts (git's unmerged `U` status). */
export async function detectConflicts(integDir: string): Promise<string[]> {
  const out = await simpleGit(integDir).raw(['diff', '--name-only', '--diff-filter=U']);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Abort an in-progress merge, restoring the integration branch to its pre-merge state. */
export async function abortMerge(integDir: string): Promise<void> {
  try {
    await simpleGit(integDir).raw(['merge', '--abort']);
  } catch {
    /* nothing to abort */
  }
}

/** Finalize a resolved merge (stage everything + commit). */
export async function commitMerge(integDir: string, message: string): Promise<void> {
  const git = simpleGit(integDir);
  await git.raw(['add', '-A']);
  await git.raw(['commit', '--no-edit', '-m', message]);
}

/** Commit a builder's worktree changes onto its lane branch so the integrator has work to merge.
 *  Returns false (no commit) when the worktree is clean. */
export async function commitWorktree(wtPath: string, message: string): Promise<boolean> {
  const git = simpleGit(wtPath);
  await git.add(['-A']);
  const status = await git.status();
  if (status.files.length === 0) return false;
  await git.commit(message);
  return true;
}

/** True if `branch` has commits the integration branch doesn't (i.e. it carries built work). */
export async function aheadOfIntegration(repoPath: string, branch: string): Promise<boolean> {
  try {
    const out = await simpleGit(repoPath).raw([
      'rev-list',
      '--count',
      `${INTEGRATION_BRANCH}..${branch}`,
    ]);
    return Number(out.trim()) > 0;
  } catch {
    return false;
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
