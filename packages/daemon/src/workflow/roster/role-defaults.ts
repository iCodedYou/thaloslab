// Role → AgentConfig defaults (DATA, SPEC §6). This is the single source of per-role policy that
// the StageRunner previously hardcoded. The provider invoke options (allowedTools/network/prompt)
// are DERIVED from the resolved AgentConfig here, so privilege lives in one place. Synthesized
// (orchestrator-created) agents are clamped to least-privilege (DECISIONS #5).
import type {
  AccessLevel,
  AgentConfig,
  AgentRole,
  AuthorityLevel,
  ToolPolicy,
} from '@thaloslab/shared';

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

/** Neutral command denylist (patterns), applied to every role on top of the allowlist. */
const DENY_COMMANDS = ['rm -rf *', 'curl *', 'wget *'];
/** Build-gate commands a builder may run. */
const BUILD_COMMANDS = ['git *', 'pnpm *', 'npm *', 'node *'];

/**
 * Derive the NEUTRAL ToolPolicy for an agent (SPEC §5). Role-specific where known, else by authority
 * (least privilege). Each provider's `enforce` translates this to its own permission mechanism; a
 * constraint a provider can't express becomes `unmet` and the router fails closed.
 */
export function policyFor(agent: AgentConfig): ToolPolicy {
  const base = (over: Partial<ToolPolicy>): ToolPolicy => ({
    canRead: true,
    canWrite: false,
    canExecCommands: false,
    commandDenylist: DENY_COMMANDS,
    network: agent.access.network,
    networkAllowlist: agent.access.networkAllowlist,
    pathScope: agent.access.pathScope,
    ...over,
  });
  switch (agent.role) {
    case 'engineer':
    case 'integrator':
      return base({ canWrite: true, canExecCommands: true, commandAllowlist: BUILD_COMMANDS });
    case 'test-author':
    case 'architect':
      return base({ canWrite: true }); // writes tests / the decomposition artifact, no exec
    case 'reviewer':
    case 'security-auditor':
    case 'orchestrator':
      return base({}); // read-only
    default:
      // custom/synthesized: by authority.
      if (agent.authority === 'L0-observe') return base({});
      if (agent.authority === 'L1-propose') return base({ canWrite: true });
      return base({ canWrite: true, canExecCommands: true, commandAllowlist: BUILD_COMMANDS });
  }
}

/** A constrained MERGE-SCOPED policy for the conflict resolver: edit conflicted files + run gates,
 *  no network — never rewrite logic to force a green build. */
export function mergeResolvePolicy(agent: AgentConfig): ToolPolicy {
  return {
    canRead: true,
    canWrite: true,
    canExecCommands: true,
    commandAllowlist: ['git add *', 'pnpm *', 'npm *', 'node *'],
    commandDenylist: DENY_COMMANDS,
    network: 'none',
    pathScope: agent.access.pathScope,
  };
}

/** Per-role cross-provider differ-rule (SPEC §5): the adversarial reviewer MUST run on a different
 *  provider than the engineer; the security auditor PREFERS to; everyone else has no constraint. */
export function differFor(role: AgentRole): 'must' | 'prefer' | 'none' {
  if (role === 'reviewer') return 'must';
  if (role === 'security-auditor') return 'prefer';
  return 'none';
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
    provider: 'auto', // the router resolves a concrete provider at assembly + invoke time
    systemPrompt: d.systemPrompt,
    authority: d.authority,
    access: d.access,
    restrictedCommands: d.restrictedCommands,
    status: 'active',
    createdBy: args.createdBy ?? 'default',
  };
}
