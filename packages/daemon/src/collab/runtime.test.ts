// 5d: the manifest viewer shows the REAL persisted record (path+sha256 of what crossed + what was
// withheld), and a peer becomes routable ONLY via an EXPLICIT host admit while collab is active — a
// valid token alone never authorizes, and a peer with no verified sandbox is never routable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SelfTestResult } from '@thaloslab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { listManifests, persistManifest } from './manifest-store';
import type { PeerHello } from './protocol';
import { CollabRuntime } from './runtime';

const okSelfTest: SelfTestResult = {
  ok: true,
  fsBlocked: true,
  netBlocked: true,
  proof: 'denied',
  id: 'bubblewrap',
  os: 'linux',
  verifiedAt: 0,
};
const hello = (peerId: string, sandbox: SelfTestResult | null): PeerHello => ({
  peerId,
  cliProviders: [{ id: 'codex', vendor: 'codex', authenticated: true }],
  sandbox,
});

const tmpdirs: string[] = [];
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('manifest store — the host sees exactly what crossed (axis 3 inform)', () => {
  it('persists + lists the real manifest entries (path+sha256) and the withheld files', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-man-'));
    tmpdirs.push(repo);
    persistManifest(repo, {
      runId: 'run1',
      peerId: 'peerB',
      createdAt: 5,
      pack: {
        files: [],
        manifest: [{ path: 'src/a.ts', sha256: 'a'.repeat(64), bytes: 12 }],
        excluded: ['.env.local', 'deploy.pem'],
      },
    });
    const list = listManifests(repo);
    expect(list).toHaveLength(1);
    expect(list[0]?.peerId).toBe('peerB');
    expect(list[0]?.entries[0]?.path).toBe('src/a.ts');
    expect(list[0]?.entries[0]?.sha256).toMatch(/^a{64}$/);
    expect(list[0]?.excluded).toEqual(['.env.local', 'deploy.pem']);
  });

  it('no manifests yet ⇒ empty (the viewer shows the truth, not a reassuring summary)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-man-'));
    tmpdirs.push(repo);
    expect(listManifests(repo)).toEqual([]);
  });
});

describe('collab runtime — routable ONLY via explicit admit, sandbox-required', () => {
  it('a valid token presented is NOT routable until the host explicitly admits (while active)', () => {
    const rt = new CollabRuntime();
    rt.registerHello(hello('peerB', okSelfTest));
    const token = rt.host.invite('peerB');
    expect(rt.host.requestJoin('peerB', token)).toBe(true); // token presented…
    rt.host.enable();
    expect(rt.state().peers[0]?.routable).toBe(false); // …but NOT admitted ⇒ not routable
    rt.host.admit('peerB'); // the explicit human action
    expect(rt.state().peers[0]?.routable).toBe(true);
    rt.host.revoke('peerB');
    expect(rt.state().peers[0]?.routable).toBe(false);
  });

  it('a peer with no verified sandbox is NEVER routable, even fully admitted (axis 1, fail-closed)', () => {
    const rt = new CollabRuntime();
    rt.registerHello(hello('peerX', null));
    const t = rt.host.invite('peerX');
    rt.host.requestJoin('peerX', t);
    rt.host.enable();
    rt.host.admit('peerX');
    const view = rt.state().peers[0];
    expect(view?.sandboxOk).toBe(false);
    expect(view?.routable).toBe(false);
  });
});
