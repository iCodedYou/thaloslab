// Config-lint for the Tauri desktop shell (SPEC §15, Phase 6). The native `tauri build` is
// DEFERRED-PENDING-TOOLCHAIN, so the locked-down tauri.conf.json + capabilities ARE the security
// artifact — and this test asserts every footgun is disabled by PARSING THE ACTUAL JSON, not by
// trusting a comment. Two claims distinct: this proves the trust-PRESERVATION intent; only a real
// build + runtime smoke on a Rust box proves the packaged app behaves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_HOST, DEFAULT_DAEMON_PORT } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAURI = path.resolve(here, '../../desktop/src-tauri');
const LOOPBACK = `http://${DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`; // http://127.0.0.1:8473

const conf = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'));
const cap = JSON.parse(fs.readFileSync(path.join(TAURI, 'capabilities', 'default.json'), 'utf8'));

describe('Tauri shell config — navigates to the loopback daemon, same-origin (no CORS forced)', () => {
  it('the window loads the loopback daemon URL — not a remote host', () => {
    const win = conf.app.windows[0];
    expect(win.url).toBe(LOOPBACK);
    expect(/^https?:\/\/127\.0\.0\.1:/.test(win.url)).toBe(true);
  });

  it('frontendDist is the loopback daemon URL — the SPA is NOT bundled as tauri:// assets', () => {
    // Bundling assets would put the webview on tauri://localhost ⇒ /api becomes cross-origin ⇒ forces
    // CORS on the daemon (a new externally-shaped surface). Navigating to the daemon keeps it same-origin.
    expect(conf.build.frontendDist).toBe(LOOPBACK);
    expect(String(conf.build.frontendDist).startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('has NO remote devUrl', () => {
    const devUrl = conf.build.devUrl;
    if (devUrl !== undefined) {
      expect(/^https?:\/\/(127\.0\.0\.1|localhost):/.test(String(devUrl))).toBe(true);
    }
  });
});

describe('Tauri shell config — CSP locks the connectable surface to loopback only', () => {
  const csp: string = conf.app.security.csp;

  it('defines a CSP', () => {
    expect(typeof csp).toBe('string');
    expect(csp.length).toBeGreaterThan(0);
  });

  it('connect-src is loopback http + ws ONLY — no wildcard, no remote origin', () => {
    const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src'));
    expect(connect).toBeDefined();
    const dir = (connect as string).trim();
    expect(dir).toContain('http://127.0.0.1:8473');
    expect(dir).toContain('ws://127.0.0.1:8473');
    expect(dir).not.toContain('*'); // no connect-src *
    // No remote scheme/host beyond loopback.
    expect(/https:\/\/(?!127\.0\.0\.1)/.test(dir)).toBe(false);
    expect(/wss:\/\/(?!127\.0\.0\.1)/.test(dir)).toBe(false);
  });

  it('default-src is self; no remote origins anywhere in the policy', () => {
    expect(csp).toContain("default-src 'self'");
    // The only non-self origins permitted are the loopback daemon ones.
    const remotes = csp.match(/https?:\/\/[^\s;'"]+/g) ?? [];
    for (const o of remotes) expect(o.startsWith('http://127.0.0.1:8473')).toBe(true);
  });
});

describe('Tauri shell config — native IPC / asset surfaces disabled', () => {
  it('withGlobalTauri is false (no IPC bridge injected into the daemon page)', () => {
    expect(conf.app.withGlobalTauri).toBe(false);
  });

  it('dangerousRemoteDomainIpcAccess is empty (no remote origin reaches native IPC)', () => {
    expect(conf.app.security.dangerousRemoteDomainIpcAccess).toEqual([]);
  });

  it('the asset protocol is disabled (we serve nothing as tauri:// assets)', () => {
    expect(conf.app.security.assetProtocol.enable).toBe(false);
  });
});

describe('Tauri shell capabilities — minimal, sidecar-scoped, no shell.open', () => {
  const perms = cap.permissions as Array<string | { identifier: string; allow?: unknown[] }>;
  const ids = perms.map((p) => (typeof p === 'string' ? p : p.identifier));

  it('grants NO shell:allow-open (no arbitrary URL/process launcher)', () => {
    expect(ids).not.toContain('shell:allow-open');
  });

  it('grants no broad fs / http / unscoped process permission', () => {
    for (const id of ids) {
      expect(id.startsWith('fs:')).toBe(false);
      expect(id.startsWith('http:')).toBe(false);
      expect(id.startsWith('process:')).toBe(false);
    }
  });

  it('the ONLY exec permission is scoped to the thaloslab launcher sidecar', () => {
    const exec = perms.find(
      (p): p is { identifier: string; allow?: Array<Record<string, unknown>> } =>
        typeof p === 'object' && p.identifier === 'shell:allow-execute',
    );
    expect(exec).toBeDefined();
    const allow = exec?.allow ?? [];
    expect(allow.length).toBe(1); // exactly one binary, not a wildcard scope
    const [scoped] = allow;
    expect(scoped?.name).toBe('binaries/thaloslab');
    expect(scoped?.sidecar).toBe(true);
  });
});

describe('Tauri shell — re-assert the daemon trust boundary it wraps', () => {
  it('the daemon bind host is still loopback (127.0.0.1)', () => {
    expect(DAEMON_HOST).toBe('127.0.0.1');
  });

  it('the daemon has not grown a CORS dependency (the same-origin model holds)', () => {
    const daemonPkg = fs.readFileSync(path.resolve(here, '../../daemon/package.json'), 'utf8');
    expect(daemonPkg).not.toContain('@fastify/cors');
  });

  it('the shell only ever points at the loopback origin (no remote URL anywhere in the config)', () => {
    // Exclude `$schema` — it is a build-tooling reference (schema.tauri.app), not a runtime origin.
    const { $schema, ...runtime } = conf;
    const urls = JSON.stringify(runtime).match(/https?:\/\/[^\s"']+/g) ?? [];
    for (const u of urls) expect(u.startsWith('http://127.0.0.1:8473')).toBe(true);
  });
});
