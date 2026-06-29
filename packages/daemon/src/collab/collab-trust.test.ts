// Axis 1 (execution containment for collab — sandbox REQUIRED, fail-closed), the reviewer-differs-by-
// VENDOR fix, the transport trust state machine, and an in-process mock-peer round-trip that ties the
// three axes together. Two claims distinct: this proves the trust/strip/quarantine LOGIC; it does NOT
// prove a real remote peer over a real wire behaves — that is DEFERRED-PENDING-MULTI-MACHINE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetectedProvider, SelfTestResult } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RouterCtx, resolveForInvoke } from '../providers/router';
import { buildContextPack } from './context-pack';
import {
  type PeerHello,
  type PeerInvokeRequest,
  type PeerResult,
  collabProviderId,
  peerRoutable,
} from './protocol';
import { applyPeerPatch } from './quarantine';
import { CollabHost } from './session';

const okSelfTest: SelfTestResult = {
  ok: true,
  fsBlocked: true,
  netBlocked: true,
  proof: 'denied',
  id: 'bubblewrap',
  os: 'linux',
  verifiedAt: 0,
};

describe('axis 1 — collab is sandbox-REQUIRED (fail-closed)', () => {
  const base = (sandbox: SelfTestResult | null): PeerHello => ({
    peerId: 'peerB',
    cliProviders: [{ id: 'codex', vendor: 'codex', authenticated: true }],
    sandbox,
  });
  it('refuses to route to a peer advertising no sandbox', () => {
    expect(peerRoutable(base(null))).toBe(false);
  });
  it('refuses to route to a peer whose self-test FAILED', () => {
    expect(peerRoutable(base({ ...okSelfTest, ok: false }))).toBe(false);
  });
  it('routes only to a peer whose self-test PASSED', () => {
    expect(peerRoutable(base(okSelfTest))).toBe(true);
  });
});

describe('reviewer-differs by VENDOR, not provider-id', () => {
  const policy = {
    canRead: true,
    canWrite: false,
    canExecCommands: false,
    network: 'none' as const,
    pathScope: 'own-worktree' as const,
  };
  const avail = (...ids: string[]): DetectedProvider[] =>
    ids.map((id) => ({
      id,
      kind: 'local' as const,
      displayName: id,
      installed: true,
      authenticated: true,
      lastChecked: 1,
    }));
  const ctx = (ids: string[]): RouterCtx => ({
    availability: avail(...ids),
    preferenceOrder: ids,
    unmetFor: () => [], // all capable
  });

  it('a collab peer running the SAME vendor is NOT a valid differ → degrades, never picks it', () => {
    // engineer ran local codex; the only other option is collab:peerB:codex (same vendor).
    const r = resolveForInvoke(ctx(['codex', collabProviderId('peerB', 'codex')]), {
      policy,
      avoidProvider: 'codex',
      differ: 'must',
    });
    expect(r).toEqual({ kind: 'ok', provider: 'codex', degraded: 'same-provider-fresh-context' });
  });

  it('a different-vendor provider (local or collab) IS a valid differ', () => {
    const r = resolveForInvoke(ctx(['codex', collabProviderId('peerC', 'claude')]), {
      policy,
      avoidProvider: 'codex',
      differ: 'must',
    });
    expect(r).toEqual({ kind: 'ok', provider: collabProviderId('peerC', 'claude') });
  });
});

describe('transport trust — one-time token + explicit admit + revoke, bound only when active', () => {
  it('a valid token alone does NOT authorize; the host must admit, and only while active', () => {
    const host = new CollabHost();
    const token = host.invite('peerB');
    expect(host.requestJoin('peerB', 'wrong')).toBe(false); // bad token
    expect(host.requestJoin('peerB', token)).toBe(true); // valid…
    expect(host.requestJoin('peerB', token)).toBe(false); // …one-time
    expect(host.authorized('peerB')).toBe(false); // requested, not admitted, not active
    host.admit('peerB');
    expect(host.authorized('peerB')).toBe(false); // admitted but collab not active
    host.enable();
    expect(host.authorized('peerB')).toBe(true);
    host.revoke('peerB');
    expect(host.authorized('peerB')).toBe(false); // revocable any time
  });

  it('disabling collab revokes every session (endpoint returns to 127.0.0.1-only)', () => {
    const host = new CollabHost();
    const t = host.invite('peerB');
    host.requestJoin('peerB', t);
    host.admit('peerB');
    host.enable();
    expect(host.authorized('peerB')).toBe(true);
    host.disable();
    expect(host.authorized('peerB')).toBe(false);
  });
});

describe('mock-peer round-trip (in-process) — the three axes end to end', () => {
  let repo: string;
  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-rt-'));
    const git = simpleGit(repo);
    await git.init(['-b', 'main']);
    fs.appendFileSync(
      path.join(repo, '.git', 'config'),
      '[user]\n\temail = t@localhost\n\tname = T\n',
    );
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = () => 0;\n');
    fs.writeFileSync(path.join(repo, '.env.local'), 'SECRET=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    await git.add('.');
    await git.commit('init');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  // A mock peer: speaks the protocol in-process, "runs in its sandbox", returns a patch. It is honest
  // here, but the host trusts NONE of its self-report.
  function mockPeer(_req: PeerInvokeRequest): PeerResult {
    // the peer only ever sees the stripped pack (asserted on the request side below)
    return {
      ok: true,
      output: 'implemented a',
      patch: { 'src/a.ts': 'export const a = () => 1;\n' },
      changedFiles: ['totally', 'made', 'up'], // ignored by the host
    };
  }

  it('packs (secrets stripped) → mock peer runs → host quarantines + derives its OWN changedFiles', async () => {
    const hello: PeerHello = {
      peerId: 'peerB',
      cliProviders: [{ id: 'codex', vendor: 'codex', authenticated: true }],
      sandbox: okSelfTest,
    };
    expect(peerRoutable(hello)).toBe(true); // axis 1: verified sandbox → routable

    const pack = buildContextPack(repo); // axis 3: .env.local stripped
    expect(pack.files.map((f) => f.path)).not.toContain('.env.local');
    expect(JSON.stringify(pack.files)).not.toContain('sk-aaaa');

    const req: PeerInvokeRequest = {
      policy: {
        canRead: true,
        canWrite: true,
        canExecCommands: true,
        network: 'none',
        pathScope: 'own-worktree',
      },
      providerId: 'codex',
      prompt: 'implement a()===1',
      contextManifest: pack.manifest,
      files: pack.files,
    };
    const result = mockPeer(req);

    // axis 2: apply in quarantine, derive changedFiles from HOST git — ignore the peer's fiction.
    const verdict = await applyPeerPatch(repo, result, ['src']);
    expect(verdict.changedFiles).toEqual(['src/a.ts']); // host git, not ['totally','made','up']
    expect(verdict.seamViolation).toEqual([]);
  });
});
