import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../workflow/worktree';
import { detectDoomLoop } from '../workflow/stuck';
import type { Run } from '@thaloslab/shared';
import { changedFiles } from './git';

let repo: string;

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-eol-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 't@localhost', false, 'local');
  await git.addConfig('user.name', 'T', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\nexport const b = 2;\n'); // LF
  await git.add('.');
  await git.commit('init');
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('changedFiles: EOL-only changes are not reported (no-progress safety)', () => {
  it('an EOL-only change (LF → CRLF) does NOT appear in changedFiles', async () => {
    const wt = await createWorktree(repo, 'eol1');
    // Write the EXACT committed content but with CRLF line endings — a true EOL-only difference
    // vs the LF blob (independent of however the checkout normalized line endings).
    fs.writeFileSync(
      path.join(wt.path, 'app.ts'),
      'export const a = 1;\r\nexport const b = 2;\r\n',
      'utf8',
    );

    const files = await changedFiles(wt.path);
    expect(files).not.toContain('app.ts');
    expect(files).not.toContain('.gitattributes'); // thalos-managed, filtered
  });

  it('a real content change IS reported', async () => {
    const wt = await createWorktree(repo, 'eol2');
    fs.writeFileSync(path.join(wt.path, 'app.ts'), 'export const a = 41;\nexport const b = 2;\n');
    const files = await changedFiles(wt.path);
    expect(files).toContain('app.ts');
  });

  it('EOL noise cannot fool the no-progress heuristic into a false stuck', () => {
    // With EOL noise excluded, two attempts making distinct REAL changes have distinct changed
    // sets → no-progress must NOT fire (the agent is genuinely progressing).
    const mk = (id: string, changed: string[]): Run => ({
      id,
      taskId: 't',
      provider: 'mock',
      status: 'error',
      startedAt: 0,
      errorSignature: id,
      changedFiles: changed,
    });
    const verdict = detectDoomLoop(
      { attempt: 1, retryCount: 1 },
      [mk('r2', ['b.ts']), mk('r1', ['a.ts'])],
      { retryCap: 3, attemptCap: 6 },
    );
    expect(verdict.stuck).toBe(false);
  });
});
