// Role → AgentConfig defaults (DATA, SPEC §6). This is the single source of per-role policy that
// the StageRunner previously hardcoded. The provider invoke options (allowedTools/network/prompt)
// are DERIVED from the resolved AgentConfig here, so privilege lives in one place. Synthesized
// (orchestrator-created) agents are clamped to least-privilege (DECISIONS #5).
import type { AccessLevel, AgentConfig, AgentRole, AuthorityLevel } from '@thaloslab/shared';

export interface RoleDefault {
  authority: AuthorityLevel;
  access: AccessLevel;
  restrictedCommands: string[];
  systemPrompt: string;
}

/** Global denylist applied to every role on top of provider permissions. */
export const GLOBAL_DENY = ['Bash(rm -rf *)', 'Bash(curl *)', 'Bash(wget *)', 'WebFetch'];

const own: AccessLevel['pathScope'] = 'own-worktree';

export const ROLE_DEFAULTS: Record<AgentRole, RoleDefault> = {
  orchestrator: {
    authority: 'L0-observe',
    access: { pathScope: own, network: 'none' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt: 'You are the orchestrator. You coordinate; you never write code.',
  },
  architect: {
    authority: 'L1-propose',
    access: { pathScope: 'project-repo', network: 'allowlist' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt:
      'You are an architect. Decompose the ticket into independently-testable work items on CLEAN module/service seams — each with explicit PATH OWNERSHIP (the files it may touch) and an interface contract. Seams must be DISJOINT. If clean seams do not exist, return exactly ONE item (sequential). Do not force a parallel split that guarantees conflicts.',
  },
  engineer: {
    authority: 'L2-execute-gated',
    access: { pathScope: own, network: 'allowlist' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt:
      'You are a senior engineer. Make the minimal correct change to satisfy the task. Stay strictly within your declared seam paths; do not touch files outside them.',
  },
  reviewer: {
    authority: 'L1-propose',
    access: { pathScope: own, network: 'none' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt:
      'You are an adversarial reviewer who did NOT write this code. Hunt for bugs, edge cases, and spec violations in the diff. Reply with APPROVE or REJECT and reasons.',
  },
  'test-author': {
    authority: 'L1-propose',
    access: { pathScope: own, network: 'none' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt:
      'You are a test author. Write a failing test that reproduces the reported bug. Do NOT fix the bug.',
  },
  'security-auditor': {
    authority: 'L0-observe',
    access: { pathScope: 'project-repo', network: 'allowlist' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt:
      'You are a security auditor. Examine auth, access control, secrets, injection, data exposure, and dependency vulnerabilities. Produce findings only; do not modify code.',
  },
  integrator: {
    authority: 'L2-execute-gated',
    access: { pathScope: own, network: 'allowlist' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt:
      'You are the integrator. Merge cleanly and, when resolving a conflict, edit ONLY the conflict markers in the conflicted files — never rewrite logic to force a green build. Then run the gates.',
  },
  custom: {
    authority: 'L1-propose',
    access: { pathScope: own, network: 'none' },
    restrictedCommands: GLOBAL_DENY,
    systemPrompt: 'You are a specialist agent. Produce your findings or change within your scope.',
  },
};

const TOOLS_BY_ROLE: Partial<Record<AgentRole, string[]>> = {
  architect: ['Read'],
  orchestrator: ['Read'],
  reviewer: ['Read'],
  'security-auditor': ['Read'],
  'test-author': ['Read', 'Write', 'Edit'],
  engineer: ['Read', 'Write', 'Edit', 'Bash(git *)', 'Bash(pnpm *)', 'Bash(npm *)', 'Bash(node *)'],
  integrator: [
    'Read',
    'Write',
    'Edit',
    'Bash(git *)',
    'Bash(pnpm *)',
    'Bash(npm *)',
    'Bash(node *)',
  ],
};

/** Derive the provider allowedTools for an agent (role-specific, else by authority — least privilege). */
export function allowedToolsFor(agent: AgentConfig): string[] {
  const byRole = TOOLS_BY_ROLE[agent.role];
  if (byRole) return byRole;
  switch (agent.authority) {
    case 'L0-observe':
      return ['Read'];
    case 'L1-propose':
      return ['Read', 'Write', 'Edit'];
    default:
      return ['Read', 'Write', 'Edit', 'Bash(git *)', 'Bash(node *)'];
  }
}

/** A constrained allowlist for the conflict-resolver pass: edit conflicted files + run gates only. */
export function mergeResolveTools(): string[] {
  return ['Read', 'Edit', 'Bash(git add *)', 'Bash(pnpm *)', 'Bash(npm *)', 'Bash(node *)'];
}

/** Clamp a synthesized (orchestrator-created) agent to least-privilege (DECISIONS #5). */
export function clampSynthesized(a: AgentConfig): AgentConfig {
  if (a.createdBy !== 'orchestrator') return a;
  const authority: AuthorityLevel = a.authority === 'L0-observe' ? a.authority : 'L1-propose';
  return { ...a, authority, access: { ...a.access, network: 'none', pathScope: 'own-worktree' } };
}

/** Build a core-roster AgentConfig from role defaults. */
export function agentFromRole(args: {
  id: string;
  projectId: string;
  role: AgentRole;
  name: string;
  createdBy?: AgentConfig['createdBy'];
}): AgentConfig {
  const d = ROLE_DEFAULTS[args.role];
  return {
    id: args.id,
    projectId: args.projectId,
    role: args.role,
    name: args.name,
    provider: 'claude',
    systemPrompt: d.systemPrompt,
    authority: d.authority,
    access: d.access,
    restrictedCommands: d.restrictedCommands,
    status: 'active',
    createdBy: args.createdBy ?? 'default',
  };
}
