// The single spawn chokepoint. EVERY agent invocation AND gate execution routes through here, so the
// jail (when verified) wraps the command and — critically — a run that the router REQUIRED to be
// sandboxed REFUSES to spawn unwrapped. The router's relaxation decision and this enforcement share the
// one `requiredByRouter`/`verified` pair on the binding, so "relaxed-but-not-wrapped" is impossible.
import type { SandboxBinding } from '@thaloslab/shared';
import { type Options, execa } from 'execa';

export class SandboxRequiredError extends Error {
  constructor(detail: string) {
    super(`fail-closed: invocation required a verified sandbox but none confined it — ${detail}`);
    this.name = 'SandboxRequiredError';
  }
}

/**
 * Spawn `cmd args` under the sandbox binding. If the binding requires a sandbox (collab / a granted
 * relaxation / --require-sandbox) but isn't `verified`, THROW — never silently run unconfined. If the
 * binding is verified, wrap the command in the jail. Otherwise (local defense-in-depth, no requirement)
 * run it unwrapped, exactly as before Phase 5.
 */
export function spawnSandboxed<O extends Options>(
  cmd: string,
  args: string[],
  execaOpts: O,
  binding: SandboxBinding | undefined,
) {
  if (binding?.requiredByRouter && !binding.verified) {
    throw new SandboxRequiredError(`sandbox ${binding.handle.id} self-test did not confine`);
  }
  const wrapped =
    binding?.verified === true ? binding.handle.wrap(cmd, args, binding.scope) : { cmd, args };
  return execa(wrapped.cmd, wrapped.args, execaOpts);
}
