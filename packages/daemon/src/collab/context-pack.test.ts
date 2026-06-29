// Axis 3 (data confidentiality) — the teeth-by-experiment on the secret strip. A clean pack passing
// proves nothing; we must prove the strip can FAIL THE RUN. Two assertions: secret-bearing files are
// ABSENT from what crosses (deny-net), AND a secret that would survive (inline in an otherwise-sendable
// file) ABORTS the build — refuses, never warns-and-sends. Once context crosses there is no claw-back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContextPack } from './context-pack';
import { SecretLeakError } from './secrets';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-pack-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = () => 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# project\n');
  // Secret-bearing files that must NEVER cross (deny-net by name):
  fs.writeFileSync(
    path.join(dir, '.env.local'),
    'OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
  );
  fs.writeFileSync(
    path.join(dir, 'deploy.pem'),
    '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('context pack — secrets never cross, and a survivor ABORTS', () => {
  it('drops deny-listed secret files: absent from the manifest + files, recorded as excluded', () => {
    const pack = buildContextPack(dir);
    const sent = pack.files.map((f) => f.path);
    expect(sent).toContain('src/app.ts');
    expect(sent).toContain('README.md');
    expect(sent).not.toContain('.env.local'); // deny-net
    expect(sent).not.toContain('deploy.pem');
    expect(pack.manifest.map((m) => m.path)).not.toContain('.env.local');
    expect(pack.excluded).toEqual(expect.arrayContaining(['.env.local', 'deploy.pem']));
    // The host-visible manifest hashes exactly what crossed.
    expect(pack.manifest.find((m) => m.path === 'src/app.ts')?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TEETH: an inline secret in an otherwise-sendable file ABORTS the build (refuses, never warns)', () => {
    // A source file (not deny-listed by name) carrying a token inline — stripping inline secrets is
    // unreliable, so the host must refuse to share the file at all.
    const leak = path.join(dir, 'src', 'leak.ts');
    fs.writeFileSync(leak, "export const k = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n");
    try {
      expect(() => buildContextPack(dir)).toThrow(SecretLeakError);
    } finally {
      fs.rmSync(leak, { force: true });
    }
  });

  it('an allowlist sends ONLY the named files (whole-repo is opt-in)', () => {
    const pack = buildContextPack(dir, { allowlist: ['src/app.ts'] });
    expect(pack.files.map((f) => f.path)).toEqual(['src/app.ts']);
  });
});
