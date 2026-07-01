// The collab peer-agent ENTRYPOINT (SPEC §11) — the production runnable that lets a sandbox-verified box
// join a host's pool. It is a standalone, DB-LESS process: NO projects/tickets DB, no lockfile, no
// Fastify, no workflow engine. It (1) self-tests its OWN sandbox HONESTLY, (2) dials the host over a real
// socket, (3) parks on pending / proceeds on admit, (4) serves invokes in its verified jail. It reuses
// `agent.ts` verbatim; this module adds only the arg/env parsing, a DB-free provider detect, and the boot
// loop. Its import closure is deliberately confined to the DB-free leaf modules (agent + sandbox + the
// DB-free `providers/adapters`) so the peer can never drag in the daemon's database — verified by grep.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAdapter } from '../../providers/adapters';
import type { PeerHello, Vendor } from '../protocol';
import { type PeerAgentHandle, connectPeer, peerSelfTest } from './agent';

const VENDORS: Vendor[] = ['claude', 'codex', 'gemini'];
const log = (...a: unknown[]): void => console.error('[thalos-peer]', ...a); // stderr: keep stdout clean

/**
 * DB-FREE detection of the peer's installed CLIs for the hello — probes the leaf adapters (each checks
 * binary presence + auth), NOT `registry.detectAll` (which touches the projects/providers DB). Advertises
 * only what is genuinely installed on this machine.
 */
export async function detectPeerCliProviders(): Promise<PeerHello['cliProviders']> {
  const out: PeerHello['cliProviders'] = [];
  for (const vendor of VENDORS) {
    const adapter = getAdapter(vendor);
    if (!adapter) continue;
    const d = await adapter.detect();
    if (d.installed)
      out.push({ id: vendor, vendor, version: d.version, authenticated: d.authenticated });
  }
  return out;
}

export interface PeerAgentOptions {
  url: string;
  peerId: string;
  token: string;
  cwd?: string;
}

export interface PeerAgentConnected {
  outcome: 'pending' | 'admitted' | 'rejected';
  reason?: string;
  hello: PeerHello;
  handle: PeerAgentHandle;
}

/**
 * Connect + handshake through the PRODUCTION path: the REAL self-test → an HONEST hello → dial → the first
 * join verdict. The refusal (or admittance) FOLLOWS from the real self-test verdict — nothing here
 * hardcodes it; feed a machine whose jail verifies and the same code parks on pending instead. Resolves at
 * the first decisive `join.*` frame.
 */
export async function connectPeerAgent(opts: PeerAgentOptions): Promise<PeerAgentConnected> {
  const cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
  const sandbox = await peerSelfTest(); // HONEST verdict for THIS machine (Noop on Windows ⇒ ok:false)
  const hello: PeerHello = {
    peerId: opts.peerId,
    cliProviders: await detectPeerCliProviders(),
    sandbox,
  };
  const handle = await connectPeer({
    url: opts.url,
    peerId: opts.peerId,
    token: opts.token,
    hello,
    cwd,
  });
  for (;;) {
    const f = await handle.next();
    if (f.t === 'join.rejected')
      return { outcome: 'rejected', reason: (f as { reason?: string }).reason, hello, handle };
    if (f.t === 'join.pending') return { outcome: 'pending', hello, handle };
    if (f.t === 'join.admitted') return { outcome: 'admitted', hello, handle };
    // ignore any stray frame until a decisive join.* arrives
  }
}

/**
 * The long-running peer process: connect, report the honest self-test, and — if not refused — stay alive
 * serving invokes (auto-served by `connectPeer` inside its verified jail) until the host says `bye`.
 * Returns a process exit code (0 clean, 3 refused-at-join).
 */
export async function runPeerAgent(opts: PeerAgentOptions): Promise<number> {
  log(`dialing ${opts.url} as "${opts.peerId}" — self-testing sandbox first…`);
  const conn = await connectPeerAgent(opts);
  const ok = conn.hello.sandbox?.ok === true;
  log(
    `sandbox self-test: ok=${ok}${ok ? '' : ' (UNVERIFIED — the host will refuse, fail-closed)'}`,
  );
  if (conn.outcome === 'rejected') {
    log(`REFUSED at join: ${conn.reason ?? 'unknown'} — exiting.`);
    conn.handle.close();
    return 3;
  }
  log(
    conn.outcome === 'admitted'
      ? 'admitted — serving invokes in the verified jail'
      : 'joined, parked on pending — awaiting the host’s explicit admit',
  );
  for (;;) {
    const f = await conn.handle.next();
    if (f.t === 'join.admitted') log('admitted — serving invokes in the verified jail');
    else if (f.t === 'bye') {
      log(`host closed the session: ${(f as { reason?: string }).reason ?? 'bye'} — exiting.`);
      conn.handle.close();
      return 0;
    } else if (f.t === 'invoke') log('invoke received — running in the verified jail (mock)');
  }
}

/** Resolve the required inputs from flags (preferred) or env, failing LOUD if any is missing — never a
 *  hardcoded host/token. */
export function parsePeerArgs(argv: string[], env: NodeJS.ProcessEnv): PeerAgentOptions {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const url = flag('--host') ?? env.THALOS_COLLAB_HOST;
  const token = flag('--token') ?? env.THALOS_COLLAB_TOKEN;
  const peerId = flag('--peer-id') ?? env.THALOS_PEER_ID;
  const cwd = flag('--cwd') ?? env.THALOS_PEER_CWD;
  const missing = [
    ['--host / THALOS_COLLAB_HOST', url],
    ['--token / THALOS_COLLAB_TOKEN', token],
    ['--peer-id / THALOS_PEER_ID', peerId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length)
    throw new Error(`thalos peer: missing required input(s): ${missing.join(', ')}`);
  return { url: url as string, token: token as string, peerId: peerId as string, cwd };
}

// Executed directly (the bundled bin, or `tsx …/index.ts`) — but NOT when imported by a test.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;
if (isMain) {
  try {
    const code = await runPeerAgent(parsePeerArgs(process.argv.slice(2), process.env));
    process.exit(code);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
