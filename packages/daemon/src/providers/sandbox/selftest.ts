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
// now VERIFIED-ON-LINUX: the real bubblewrap jail genuinely DENIED both escapes on kernel 6.18.x WSL2 +
// bubblewrap 0.11.1 (fs by host-readback, net by ENETUNREACH under --unshare-net). macOS sandbox-exec
// stays DEFERRED-PENDING-MACOS.
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

// Writes THALOS_PROBE_TOKEN to THALOS_PROBE_OUTSIDE (a HOST path), then attempts an outbound socket.
// FS verdict is by HOST-READBACK, not the probe's self-report: a container's fs is writable but
// host-ISOLATED, so a probe that "wrote a file" did NOT necessarily reach the host — only the harness,
// reading the host path afterwards, can tell whether the write truly escaped.
//
// NET probes a ROUTABLE, non-loopback address. `127.0.0.1` would be wrong: every network namespace has
// its OWN loopback, present even under `--unshare-net`, so a loopback probe cannot tell an isolated
// namespace from the host (verified on a real Linux kernel — DEFERRED-PENDING-LINUX). We use TEST-NET-1
// (192.0.2.1, RFC 5737 documentation space): no real host is ever contacted — when net is denied the
// kernel returns a no-route error IMMEDIATELY (isolated), and when net is present the SYN dies unrouted
// (timeout). Only the no-route codes prove isolation; CONNECT / refused / reset / unknown / timeout all
// mean the stack was REACHABLE ⇒ connectedOut:true (fail-closed: never claim an isolation we didn't see).
const PROBE_SRC = `
import fs from 'node:fs';
import net from 'node:net';
const out = { selfWrote: false, connectedOut: false, fsErr: '', netErr: '' };
const outside = process.env.THALOS_PROBE_OUTSIDE;
const token = process.env.THALOS_PROBE_TOKEN || 'x';
try { fs.writeFileSync(outside, token); out.selfWrote = true; } catch (e) { out.fsErr = e && e.code ? e.code : String(e); }
let done = false;
const finish = () => { if (done) return; done = true; process.stdout.write('PROBE:' + JSON.stringify(out)); process.exit(0); };
const NET_BLOCKED = ['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL'];
const s = net.connect({ host: '192.0.2.1', port: 53 });
s.on('connect', () => { out.connectedOut = true; finish(); });
s.on('error', (e) => { const c = (e && e.code) || ''; if (NET_BLOCKED.indexOf(c) === -1) out.connectedOut = true; else out.netErr = c; finish(); });
setTimeout(() => { out.connectedOut = true; finish(); }, 1500);
`;

interface ProbeReport {
  selfWrote: boolean;
  connectedOut: boolean;
}

/** Run the escape probe under `handle`'s jail. The rw set is a throwaway dir; the escape target is a
 *  HOST path OUTSIDE it. `wroteOutside` is decided by HOST-READBACK (did the probe's token actually
 *  land in the host file?), so a container that isolates without denying the write is correctly judged
 *  confined. Net is by the probe's own reachability. */
export async function runEscapeProbe(handle: Sandbox): Promise<ProbeOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-sbx-'));
  const probeFile = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probeFile, PROBE_SRC, 'utf8');
  const outside = path.join(os.tmpdir(), `thalos-escape-${process.pid}-${Date.now()}`);
  const token = `ESCAPED-${process.pid}-${Date.now()}`;
  const scope: SandboxScope = { fsScope: { rw: [dir], hideRest: true }, network: 'none' };
  const wrapped = handle.wrap('node', [probeFile], scope);
  try {
    const res = await execa(wrapped.cmd, wrapped.args, {
      cwd: dir,
      timeout: 20_000,
      reject: false,
      env: { ...process.env, THALOS_PROBE_OUTSIDE: outside, THALOS_PROBE_TOKEN: token },
    });
    // AUTHORITATIVE fs verdict: did the probe's write actually reach the HOST file?
    let hostEscaped = false;
    try {
      hostEscaped = fs.readFileSync(outside, 'utf8').includes(token);
    } catch {
      hostEscaped = false; // host file absent ⇒ the write never reached the host ⇒ confined
    }
    const report = parseProbe(res.stdout ?? '');
    return { wroteOutside: hostEscaped, connectedOut: report.connectedOut, raw: res.stdout ?? '' };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Parse the `PROBE:{json}` line for the probe's self-report. An unparseable/absent line is treated as
 *  reachable on BOTH axes (fail-closed): if we can't read the probe, we don't get to call it confined. */
export function parseProbe(stdout: string): ProbeReport {
  const marker = stdout.lastIndexOf('PROBE:');
  if (marker === -1) return { selfWrote: true, connectedOut: true };
  try {
    const obj = JSON.parse(stdout.slice(marker + 'PROBE:'.length).trim()) as ProbeReport;
    return { selfWrote: !!obj.selfWrote, connectedOut: !!obj.connectedOut };
  } catch {
    return { selfWrote: true, connectedOut: true };
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
