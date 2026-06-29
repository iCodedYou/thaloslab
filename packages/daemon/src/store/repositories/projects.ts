// Data access for the `projects` table (one of two repositories built in Phase 0, DECISIONS #19).
import { eq } from 'drizzle-orm';
import type { Project, ProjectPhase } from '@thaloslab/shared';
import { getDb } from '../db';
import { projects } from '../schema';

type Row = typeof projects.$inferSelect;

function toProject(row: Row): Project {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repoPath,
    githubUrl: row.githubUrl ?? undefined,
    origin: row.origin,
    phase: row.phase,
    orchestratorProvider: row.orchestratorProvider,
    routingPolicy: row.routingPolicyJson
      ? (JSON.parse(row.routingPolicyJson) as Record<string, unknown>)
      : undefined,
    createdAt: row.createdAt,
  };
}

export function listProjects(): Project[] {
  return getDb().select().from(projects).all().map(toProject);
}

export function getProject(id: string): Project | null {
  const row = getDb().select().from(projects).where(eq(projects.id, id)).get();
  return row ? toProject(row) : null;
}

/** Flip a project's lifecycle phase (the DB is authoritative; .thalos/config.json is a mirror). The
 *  only mutation of `projects` so far — a one-column update, kept minimal (Phase 4 transition). */
export function setProjectPhase(id: string, phase: ProjectPhase): void {
  getDb().update(projects).set({ phase }).where(eq(projects.id, id)).run();
}

export function insertProject(p: Project): Project {
  getDb()
    .insert(projects)
    .values({
      id: p.id,
      name: p.name,
      repoPath: p.repoPath,
      githubUrl: p.githubUrl ?? null,
      origin: p.origin,
      phase: p.phase,
      orchestratorProvider: p.orchestratorProvider,
      routingPolicyJson: p.routingPolicy ? JSON.stringify(p.routingPolicy) : null,
      createdAt: p.createdAt,
    })
    .run();
  return p;
}
