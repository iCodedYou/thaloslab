// F0 — the collab ROUTES must drive `collabService` so enable actually OPENS the socket. Before this,
// the routes called the bare `collab` runtime (state flipped, but NO listener started → no peer could ever
// connect). This proves the fix at the route layer: POST enable opens a REAL socket that speaks the join
// handshake, and POST disable CLOSES the listener (the port is released). No off-loopback here (that is F2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageOutcome, StageRunner } from '../../workflow/engine';
import type { CollabPeerView } from '../../collab/runtime';
import { collabTargets } from './collab';

// Ephemeral collab port — NEVER bind the fixed 8474 in a test (flaky under parallelism).
process.env.THALOS_COLLAB_PORT = '0';
const dbFile = path.join(os.tmpdir(), `thalos-collabroutes-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../../store/db');
const { runMigrations } = await import('../../store/migrate');
const { buildApp } = await import('../app');
const { createRuntime } = await import('../../workflow/runtime');
const { collabService } = await import('../../collab/collab-service');

const OK: StageOutcome = { ok: true, changedFiles: [] };
const scriptedRunner: StageRunner = { run: () => Promise.resolve(OK) };

let app: Awaited<ReturnType<typeof buildApp>>;

function firstFrame(ws: WebSocket): Promise<{ t: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
    ws.once('error', reject);
  });
}
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

beforeAll(async () => {
  runMigrations(openDb());
  const runtime = createRuntime({ stageRunner: scriptedRunner });
  app = buildApp({ health: { version: 't', startedAt: 0, getPort: () => 0 }, runtime });
  await app.ready();
});

afterAll(async () => {
  if (collabService.endpoint.listening) await collabService.disable();
  await app.close();
  closeDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('collab routes drive the service (the socket actually opens)', () => {
  it('POST enable opens a REAL socket that speaks the handshake; POST disable closes the listener', async () => {
    // No listener at rest — the daemon never opens the collab port at boot.
    expect(collabService.endpoint.listening).toBe(false);

    const res = await app.inject({ method: 'POST', url: '/api/collab/enable' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { active: boolean; collabPort: number };
    expect(body.active).toBe(true);
    expect(body.collabPort).toBeGreaterThan(0);
    // The ROUTE started the socket — the whole point of F0 (a false here was the production bug).
    expect(collabService.endpoint.listening).toBe(true);

    // A real ws client reaches it and the endpoint SPEAKS the protocol: a bogus token → join.rejected.
    const ws = new WebSocket(`ws://127.0.0.1:${body.collabPort}`);
    await opened(ws);
    const frame = firstFrame(ws);
    ws.send(
      JSON.stringify({
        t: 'join',
        peerId: 'p',
        token: 'bogus-never-issued',
        hello: { peerId: 'p', cliProviders: [], sandbox: null },
      }),
    );
    expect((await frame).t).toBe('join.rejected'); // live socket, real handshake, fail-closed on token
    ws.close();

    const off = await app.inject({ method: 'POST', url: '/api/collab/disable' });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { active: boolean }).active).toBe(false);
    // Listener closed → the port is released (back to no-listener, the strongest "127.0.0.1-only").
    expect(collabService.endpoint.listening).toBe(false);

    // A fresh connection to the now-closed port is refused.
    const refused = new WebSocket(`ws://127.0.0.1:${body.collabPort}`);
    await expect(opened(refused)).rejects.toBeDefined();
  });

  it('invite issues a one-time token, and admit/revoke are reachable over REST', async () => {
    await app.inject({ method: 'POST', url: '/api/collab/enable' });
    const inv = await app.inject({ method: 'POST', url: '/api/collab/peers/mac-1/invite' });
    expect(inv.statusCode).toBe(200);
    const token = (inv.json() as { token: string }).token;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    // admit + revoke reach the service and return the serializable state (no throw, structurally wired).
    expect(
      (await app.inject({ method: 'POST', url: '/api/collab/peers/mac-1/admit' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/collab/peers/mac-1/revoke' })).statusCode,
    ).toBe(200);
    await collabService.disable();
  });
});

describe('H2 — collab targets: valid ids for ROUTABLE peers only', () => {
  const peer = (over: Partial<CollabPeerView>): CollabPeerView => ({
    peerId: 'x',
    vendors: ['codex'],
    sandboxOk: true,
    joinRequested: true,
    admitted: true,
    revoked: false,
    routable: true,
    ...over,
  });

  it('derives collab:<peer>:<vendor> per advertised vendor for a ROUTABLE peer', () => {
    const targets = collabTargets([
      peer({ peerId: 'r1', vendors: ['codex', 'claude'], routable: true }),
    ]);
    expect(targets.map((t) => t.providerId)).toEqual(['collab:r1:codex', 'collab:r1:claude']);
  });

  it('EXCLUDES a non-routable peer — its ids are never offered (picking one would just PARK)', () => {
    const targets = collabTargets([
      peer({ peerId: 'r1', vendors: ['codex'], routable: true }),
      peer({ peerId: 'n1', vendors: ['codex', 'gemini'], routable: false }), // parked / not admitted
    ]);
    expect(targets.map((t) => t.providerId)).toEqual(['collab:r1:codex']);
    expect(targets.some((t) => t.peerId === 'n1')).toBe(false);
  });

  it('GET /api/collab/targets returns [] when no peer is routable (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/collab/targets' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
