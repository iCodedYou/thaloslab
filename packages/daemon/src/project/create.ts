// From-scratch project creation. The local git repo is ALWAYS created; GitHub create/push is
// best-effort and degrades to local-only with a notice when gh is missing/unauthenticated
// (SPEC §9, DECISIONS #18).
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Project, ProviderId } from '@thaloslab/shared';
import { insertProject } from '../store/repositories/projects';
import { scaffoldThalos } from '../store/thalos-layout';
import { whichSync } from '../providers/which';
import { genId } from '../util/id';

export interface CreateProjectInput {
  name: string;
  repoPath: string;
  orchestratorProvider: ProviderId;
  /** Attempt to create + push a GitHub remote (best-effort). */
  github?: boolean;
}

export interface CreateProjectResult {
  project: Project;
  notice?: string;
}

async function ensureCommit(git: SimpleGit, message: string): Promise<void> {
  try {
    await git.commit(message);
  } catch {
    // No commit identity configured — set a repo-local fallback (non-intrusive) and retry.
    await git.addConfig('user.email', 'thalos@localhost', false, 'local');
    await git.addConfig('user.name', 'Thalos Lab', false, 'local');
    await git.commit(message);
  }
}

async function tryCreateGithub(
  repoPath: string,
  name: string,
): Promise<{ url?: string; notice?: string }> {
  const gh = whichSync('gh');
  if (!gh) return { notice: 'created locally; connect the `gh` CLI to push to GitHub' };
  try {
    await execa(gh, ['auth', 'status'], { timeout: 10_000 });
  } catch {
    return { notice: 'created locally; run `gh auth login` to push to GitHub' };
  }
  try {
    const { stdout } = await execa(
      gh,
      ['repo', 'create', name, '--private', '--source', '.', '--push'],
      { cwd: repoPath, timeout: 60_000 },
    );
    const url = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('http'));
    return { url };
  } catch {
    return { notice: 'created locally; GitHub repo creation failed — push manually later' };
  }
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const repoPath = path.resolve(input.repoPath);
  fs.mkdirSync(repoPath, { recursive: true });

  const git = simpleGit(repoPath);
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    await git.init(['-b', 'main']);
  }

  scaffoldThalos(repoPath, {
    phase: 'bootstrapping',
    orchestratorProvider: input.orchestratorProvider,
  });

  const readme = path.join(repoPath, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, `# ${input.name}\n`, 'utf8');

  await git.add('.');
  let notice: string | undefined;
  await ensureCommit(git, 'Initial commit (Thalos Lab)');

  let githubUrl: string | undefined;
  if (input.github) {
    const gh = await tryCreateGithub(repoPath, input.name);
    githubUrl = gh.url;
    notice = gh.notice;
  }

  const project: Project = {
    id: genId('p'),
    name: input.name,
    repoPath,
    githubUrl,
    origin: 'scratch',
    phase: 'bootstrapping',
    orchestratorProvider: input.orchestratorProvider,
    createdAt: Date.now(),
  };
  insertProject(project);
  return { project, notice };
}
