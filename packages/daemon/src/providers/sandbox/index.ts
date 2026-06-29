// Sandbox resolution + the self-test cache. Phase 5a wires the abstraction + the fail-closed math; the
// real per-OS jails (bubblewrap/sandbox-exec/wsl2) arrive in 5b behind `detectSandbox`. Until then the
// platform sandbox is the NoopSandbox → selfTest ok:false → local runs unsandboxed (defense in depth,
// the documented floor), collab refuses (fail-closed).
import type {
  Sandbox,
  SandboxBinding,
  SandboxCapability,
  SandboxScope,
  SelfTestResult,
  ToolPolicy,
} from '@thaloslab/shared';
import { noopSandbox } from './noop';

let override: Sandbox | null = null;

/** Test seam: force the platform sandbox (e.g. a hollow/confining mock). resetSandbox() restores. */
export function setSandbox(s: Sandbox | null): void {
  override = s;
  cache.clear();
}
export function resetSandbox(): void {
  override = null;
  cache.clear();
}

/** The platform sandbox. 5a: NoopSandbox everywhere (real jails are 5b). */
export function detectSandbox(): Sandbox {
  if (override) return override;
  return noopSandbox; // 5b: return bubblewrap/sandbox-exec/wsl2 when detected + available
}

const cache = new Map<string, SelfTestResult>();
const TTL_MS = 10 * 60 * 1000;

/** Run (and cache) the keystone self-test, keyed on (id, version, os-build). A degraded/upgraded jail
 *  invalidates the cache. Never trust a sandbox whose self-test hasn't proven confinement. */
export async function verifiedSelfTest(handle: Sandbox): Promise<SelfTestResult> {
  const probe = await handle.detect();
  const key = `${handle.id}@${probe.version ?? '?'}@${process.platform}-${process.arch}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.verifiedAt < TTL_MS) return hit;
  const result = await handle.selfTest();
  cache.set(key, result);
  return result;
}

/** Derive the confinement an invocation needs from its policy + cwd. */
export function scopeFor(policy: ToolPolicy, cwd: string, repoRoot?: string): SandboxScope {
  const rw =
    policy.pathScope === 'own-worktree'
      ? [cwd]
      : policy.pathScope === 'project-repo'
        ? [repoRoot ?? cwd]
        : []; // 'machine' ⇒ no confinement requested (and none possible)
  return {
    fsScope: { rw, hideRest: policy.pathScope !== 'machine' },
    network: policy.network === 'none' ? 'none' : 'inherit',
  };
}

/**
 * Resolve the sandbox binding for an invocation. `required` = collab, or the router granted a
 * relaxation, or `--require-sandbox`. Returns the binding the engine threads onto InvokeOptions and the
 * router consults. `verified` is true ONLY when the self-test proved confinement.
 */
export async function resolveSandboxBinding(
  policy: ToolPolicy,
  cwd: string,
  opts: { required: boolean; repoRoot?: string } = { required: false },
): Promise<SandboxBinding> {
  const handle = detectSandbox();
  const selfTest = await verifiedSelfTest(handle);
  return {
    handle,
    scope: scopeFor(policy, cwd, opts.repoRoot),
    verified: selfTest.ok,
    requiredByRouter: opts.required,
  };
}

/** Capabilities to trust for THIS run: the handle's declared caps, but ONLY if the self-test passed.
 *  A jail that "starts but doesn't confine" reports caps but fails the self-test ⇒ trust nothing. */
export function trustedCapabilities(binding: SandboxBinding | undefined): SandboxCapability[] {
  return binding?.verified ? binding.handle.capabilities() : [];
}
