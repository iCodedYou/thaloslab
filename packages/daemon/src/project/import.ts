// Import an existing project: clone from a remote (if a URL is given) or reference an existing
// local repo. Imported projects start in `maintenance` phase (SPEC §6). The `.thalos/` tree is
// scaffolded if absent; the DB row mirrors it (DECISIONS #14).
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { Project, ProviderId } from '@thaloslab/shared';
import { insertProject } from '../store/repositories/projects';
import { scaffoldThalos, thalosDir } from '../store/thalos-layout';
import { genId } from '../util/id';

export interface ImportProjectInput {
  name?: string;
  /** Remote URL to clone; if omitted, `repoPath` must already be a git repo. */
  repoUrl?: string;
  repoPath: string;
  orchestratorProvider: ProviderId;
}

export interface ImportProjectResult {
  project: Project;
  notice?: string;
}

export async function importProject(input: ImportProjectInput): Promise<ImportProjectResult> {
  const repoPath = path.resolve(input.repoPath);

  if (input.repoUrl) {
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    await simpleGit().clone(input.repoUrl, repoPath);
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`not a git repository: ${repoPath} (provide repoUrl to clone)`);
  }

  if (!fs.existsSync(thalosDir(repoPath))) {
    scaffoldThalos(repoPath, {
      phase: 'maintenance',
      orchestratorProvider: input.orchestratorProvider,
    });
  }

  // Best-effort remote URL for display.
  let githubUrl: string | undefined;
  try {
    const remotes = await simpleGit(repoPath).getRemotes(true);
    githubUrl = remotes.find((r) => r.name === 'origin')?.refs.fetch || undefined;
  } catch {
    // no remotes — fine
  }

  const project: Project = {
    id: genId('p'),
    name: input.name ?? path.basename(repoPath),
    repoPath,
    githubUrl,
    origin: 'imported',
    phase: 'maintenance',
    orchestratorProvider: input.orchestratorProvider,
    createdAt: Date.now(),
  };
  insertProject(project);
  return { project };
}
