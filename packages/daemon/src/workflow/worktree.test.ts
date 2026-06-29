import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTEGRATION_BRANCH,
  auditScope,
  captureDiff,
  createWorktree,
  integrate,
  teardownWorktree,
} from './worktree';

let repo: string;

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-wt-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 'test@localhost', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'original\n');
  await git.add('.');
  await git.commit('init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('worktree lifecycle', () => {
  it('creates a task worktree on a branch off thalos/integration (never main)', async () => {
    const wt = await createWorktree(repo, 'abc123');
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(wt.branch).toBe('thalos/lane-abc123');
    const branches = await simpleGit(repo).branchLocal();
    expect(branches.all).toContain(INTEGRATION_BRANCH);
    expect(branches.all).toContain('thalos/lane-abc123');
  });

  it('scope audit: clean when work stays in the worktree, flags writes to the main repo', async () => {
    const wt = await createWorktree(repo, 'abc123');
    // Work INSIDE the worktree — main stays clean.
    fs.writeFileSync(path.join(wt.path, 'app.txt'), 'fixed in worktree\n');
    expect((await auditScope(repo)).ok).toBe(true);

    // Simulate an escape: a write into the MAIN repo outside the worktree.
    fs.writeFileSync(path.join(repo, 'escaped.txt'), 'oops\n');
    const audit = await auditScope(repo);
    expect(audit.ok).toBe(false);
    expect(audit.offending).toContain('escaped.txt');
  });

  it('integrate merges the task branch into thalos/integration and leaves main untouched', async () => {
    const wt = await createWorktree(repo, 'abc123');
    const wtGit = simpleGit(wt.path);
    fs.writeFileSync(path.join(wt.path, 'app.txt'), 'fixed\n');
    await wtGit.add('.');
    await wtGit.commit('fix the bug');

    const diff = await captureDiff(repo, wt.branch);
    expect(diff).toContain('fixed');

    const res = await integrate(repo, wt.branch);
    expect(res.ok).toBe(true);

    // integration branch has the fix; main is unchanged.
    const onIntegration = await simpleGit(repo).raw(['show', `${INTEGRATION_BRANCH}:app.txt`]);
    expect(onIntegration).toContain('fixed');
    const onMain = await simpleGit(repo).raw(['show', 'main:app.txt']);
    expect(onMain.trim()).toBe('original');
  });

  it('slugs colon lane ids and ADOPTS an existing lane on a second call (crash recovery)', async () => {
    const wt1 = await createWorktree(repo, 'tk:seam-0');
    expect(wt1.branch).toBe('thalos/lane-tk-seam-0');
    fs.writeFileSync(path.join(wt1.path, 'work.txt'), 'in progress\n');

    // The in-memory cache is gone (simulated by calling again) but the lane survives on disk —
    // a second create must adopt it, not throw "branch/worktree already exists".
    const wt2 = await createWorktree(repo, 'tk:seam-0');
    expect(wt2.path).toBe(wt1.path);
    expect(wt2.branch).toBe(wt1.branch);
    expect(fs.existsSync(path.join(wt2.path, 'work.txt'))).toBe(true);
  });

  it('isolates distinct lanes in distinct worktrees + branches', async () => {
    const a = await createWorktree(repo, 'tk:seam-0');
    const b = await createWorktree(repo, 'tk:seam-1');
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
  });

  it('teardown removes the worktree but retains the branch', async () => {
    const wt = await createWorktree(repo, 'abc123');
    const result = await teardownWorktree(repo, wt);
    expect(result.removed).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
    const branches = await simpleGit(repo).branchLocal();
    expect(branches.all).toContain('thalos/lane-abc123'); // branch retained
  });
});
