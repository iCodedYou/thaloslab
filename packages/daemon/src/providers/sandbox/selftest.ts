// The sandbox self-test — the KEYSTONE of Phase 5. "Verified" means an escape that SHOULD have been
// denied WAS denied, proven by running a real probe under a denying scope. "The binary exists" is not
// verification; a sandbox that starts but does not confine is the worst outcome in this phase.
//
// The probe attempts two escapes and reports which SUCCEEDED:
//   - write a file OUTSIDE the rw set (fs escape),
//   - reach the network stack under network:'none' (net escape).
// The verdict is ok ⇔ BOTH escapes were blocked. A jail that lets either escape through ⇒ ok:false.
//
// On the Windows build box there is no real jail, so a real probe ESCAPES (writes outside, reaches the
// stack) and the verdict is correctly ok:false → fail-closed. That is not a limitation: it is the
// system refusing to trust a non-confining environment. Real confinement (probe blocked ⇒ ok:true) is
// verified on Linux/macOS in 5b (DEFERRED-PENDING-LINUX/MACOS).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sandbox, SandboxScope, SelfTestResult } from '@thaloslab/shared';
import { execa } from 'execa';

export interface ProbeOutcome {
  /** The write to a path OUTSIDE the rw set SUCCEEDED (jail failed to confine the filesystem). */
  wroteOutside: boolean;
  /** The outbound socket reached the network stack (jail failed to deny the network). */
  connectedOut: boolean;
  raw: string;
}

// Reads THALOS_PROBE_OUTSIDE; attempts the two escapes; prints `PROBE:{json}`. Errno classification:
// a jail blocks fs with EACCES/EROFS/EPERM/ENOENT and net with ENETUNREACH/ENETDOWN/EPERM/EACCES; a
// non-jailed host writes successfully and gets ECONNREFUSED/ETIMEDOUT (stack reachable) on a dead port.
const PROBE_SRC = `
import fs from 'node:fs';
import net from 'node:net';
const out = { wroteOutside: false, connectedOut: false, fsErr: '', netErr: '' };
const outside = process.env.THALOS_PROBE_OUTSIDE;
try { fs.writeFileSync(outside, 'x'); out.wroteOutside = true; try { fs.unlinkSync(outside); } catch {} }
catch (e) { out.fsErr = e && e.code ? e.code : String(e); }
let done = false;
const finish = () => { if (done) return; done = true; process.stdout.write('PROBE:' + JSON.stringify(out)); process.exit(0); };
const s = net.connect({ host: '127.0.0.1', port: 1 });
s.on('connect', () => { out.connectedOut = true; finish(); });
s.on('error', (e) => { const c = (e && e.code) || ''; if (c === 'ECONNREFUSED' || c === 'ETIMEDOUT' || c === 'ECONNRESET') out.connectedOut = true; else out.netErr = c; finish(); });
setTimeout(finish, 1500);
`;

/** Run the escape probe under `handle`'s jail and report what got through. Used by every real
 *  Sandbox.selfTest(); the rw set is a throwaway dir so the "outside" target is genuinely outside. */
export async function runEscapeProbe(handle: Sandbox): Promise<ProbeOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-sbx-'));
  const probeFile = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probeFile, PROBE_SRC, 'utf8');
  const outside = path.join(os.tmpdir(), `thalos-escape-${process.pid}-${Date.now()}`);
  const scope: SandboxScope = { fsScope: { rw: [dir], hideRest: true }, network: 'none' };
  const wrapped = handle.wrap('node', [probeFile], scope);
  try {
    const res = await execa(wrapped.cmd, wrapped.args, {
      cwd: dir,
      timeout: 15_000,
      reject: false,
      env: { ...process.env, THALOS_PROBE_OUTSIDE: outside },
    });
    return parseProbe(res.stdout ?? '');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Parse the `PROBE:{json}` line. An unparseable/absent line is treated as an ESCAPE (fail-closed):
 *  if we can't prove the probe was confined, we must not call it confined. */
export function parseProbe(stdout: string): ProbeOutcome {
  const marker = stdout.lastIndexOf('PROBE:');
  if (marker === -1) return { wroteOutside: true, connectedOut: true, raw: stdout };
  try {
    const obj = JSON.parse(stdout.slice(marker + 'PROBE:'.length).trim()) as ProbeOutcome;
    return { wroteOutside: !!obj.wroteOutside, connectedOut: !!obj.connectedOut, raw: stdout };
  } catch {
    return { wroteOutside: true, connectedOut: true, raw: stdout };
  }
}

/** Pure verdict: ok ONLY if BOTH escapes were blocked. This is the discriminating logic the meta-test
 *  exercises in both directions (escaped → fail; blocked → ok). */
export function verdictFromProbe(
  probe: ProbeOutcome,
  meta: { id: string; version?: string; os: string; verifiedAt: number },
): SelfTestResult {
  const fsBlocked = !probe.wroteOutside;
  const netBlocked = !probe.connectedOut;
  return {
    ok: fsBlocked && netBlocked,
    fsBlocked,
    netBlocked,
    proof: probe.raw.slice(0, 2000),
    ...meta,
  };
}
