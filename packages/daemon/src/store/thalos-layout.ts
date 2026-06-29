// Per-repo `.thalos/` scaffolding (SPEC §10, DECISIONS #6/#14). Tracks agents/ + config.json;
// gitignores artifacts/, worktrees/, runs.log. Artifact bytes + portable agent configs live here;
// the global DB indexes/mirrors them.
import fs from 'node:fs';
import path from 'node:path';
import {
  THALOS_AGENTS_DIR,
  THALOS_ARTIFACTS_DIR,
  THALOS_CONFIG_NAME,
  THALOS_DIR_NAME,
  THALOS_RUNS_LOG,
  THALOS_WORKTREES_DIR,
} from '@thaloslab/shared';

export interface ThalosConfig {
  phase: 'bootstrapping' | 'maintenance';
  orchestratorProvider: string;
  routingPolicy?: Record<string, unknown>;
}

export function thalosDir(repoPath: string): string {
  return path.join(repoPath, THALOS_DIR_NAME);
}

const GITIGNORE = [
  '# Thalos: track agents/ + config.json; ignore artifacts, worktrees, runs (DECISIONS #6)',
  `${THALOS_ARTIFACTS_DIR}/`,
  `${THALOS_WORKTREES_DIR}/`,
  THALOS_RUNS_LOG,
  '',
].join('\n');

export function scaffoldThalos(repoPath: string, config: ThalosConfig): void {
  const dir = thalosDir(repoPath);
  fs.mkdirSync(path.join(dir, THALOS_AGENTS_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, THALOS_ARTIFACTS_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, THALOS_WORKTREES_DIR), { recursive: true });

  // config.json (tracked) — overwrite to reflect the current config
  fs.writeFileSync(
    path.join(dir, THALOS_CONFIG_NAME),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );

  // runs.log (gitignored) — ensure present
  const runsLog = path.join(dir, THALOS_RUNS_LOG);
  if (!fs.existsSync(runsLog)) fs.writeFileSync(runsLog, '', 'utf8');

  // .thalos/.gitignore — the track/ignore split
  fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE, 'utf8');

  // keep the tracked agents/ dir committable while empty
  const agentsKeep = path.join(dir, THALOS_AGENTS_DIR, '.gitkeep');
  if (!fs.existsSync(agentsKeep)) fs.writeFileSync(agentsKeep, '', 'utf8');
}

export function readThalosConfig(repoPath: string): ThalosConfig | null {
  try {
    const raw = fs.readFileSync(path.join(thalosDir(repoPath), THALOS_CONFIG_NAME), 'utf8');
    return JSON.parse(raw) as ThalosConfig;
  } catch {
    return null;
  }
}
