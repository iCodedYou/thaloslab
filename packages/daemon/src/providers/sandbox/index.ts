// Sandbox resolution + the self-test cache. Phase 5a wires the abstraction + the fail-closed math; the
// real per-OS jails arrive in 5b behind `detectSandbox` — bubblewrap (VERIFIED-ON-LINUX), sandbox-exec
// (VERIFIED-ON-MACOS); Windows (WSL2/Docker) is still DEFERRED. On a platform with no backend the
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
import { bubblewrapSandbox } from './bubblewrap';
import { noopSandbox } from './noop';
import { sandboxExecSandbox } from './sandbox-exec';

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

/** Per-platform jail CANDIDATES, best first. Availability (binary present) is checked here; real
 *  CONFINEMENT is checked later by the self-test — a present-but-misconfigured jail is detected here
 *  but never TRUSTED until its self-test passes. Linux = bubblewrap (VERIFIED-ON-LINUX); macOS =
 *  sandbox-exec (VERIFIED-ON-MACOS). Windows (WSL2/Docker) stays DEFERRED — on a box without a
 *  candidate, candidates() is empty and we fall back to Noop. */
function candidates(): Sandbox[] {
  if (process.platform === 'linux') return [bubblewrapSandbox];
  if (process.platform === 'darwin') return [sandboxExecSandbox];
  return []; // Windows real backends: DEFERRED-PENDING-WSL-OR-DOCKER
}

/** The platform sandbox: the first AVAILABLE candidate, else NoopSandbox. "Available" = the binary is
 *  present; it is still not TRUSTED until verifiedSelfTest() proves it confines. */
export async function detectSandbox(): Promise<Sandbox> {
  if (override) return override;
  for (const candidate of candidates()) {
    if ((await candidate.detect()).available) return candidate;
  }
  return noopSandbox;
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
  const handle = await detectSandbox();
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
