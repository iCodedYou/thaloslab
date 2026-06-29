// Each specialist gate runs a REAL check (the no-silent-no-op rule): security flags a seeded
// secret/vuln/dangerous pattern, benchmark fails on a seeded regression, a11y fails on seeded
// violations. Asserted, not assumed.
import { describe, expect, it } from 'vitest';
import {
  benchmarkRegressed,
  checkA11y,
  parseBenchmark,
  parseNpmAudit,
  scanSast,
  scanSecrets,
} from './specialist-gates';

describe('security scan flags real findings', () => {
  it('flags a hardcoded AWS key and a private key (secret scan)', () => {
    const findings = scanSecrets([
      { path: 'config.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";' },
      { path: 'key.pem', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' },
      { path: 'clean.ts', content: 'export const x = 1;' },
    ]);
    expect(findings.map((f) => f.detail)).toEqual([
      expect.stringContaining('AWS access key id in config.ts'),
      expect.stringContaining('private key in key.pem'),
    ]);
  });

  it('flags eval() and shell interpolation (SAST)', () => {
    const findings = scanSast([
      { path: 'a.ts', content: 'eval(userInput)' },
      { path: 'b.ts', content: 'import cp from "child_process"; cp.exec(`ls ${dir}`)' },
      { path: 'ok.ts', content: 'const y = 2;' },
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.detail.includes('eval'))).toBe(true);
  });

  it('flags high/critical npm audit advisories, ignores low', () => {
    const json = JSON.stringify({
      vulnerabilities: {
        lodash: { severity: 'critical' },
        minimist: { severity: 'high' },
        trivial: { severity: 'low' },
      },
    });
    const findings = parseNpmAudit(json);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.kind === 'dependency')).toBe(true);
  });

  it('a clean changeset produces no findings', () => {
    expect(scanSecrets([{ path: 'x.ts', content: 'export const x = 1;' }])).toEqual([]);
    expect(scanSast([{ path: 'x.ts', content: 'export const x = 1;' }])).toEqual([]);
  });
});

describe('benchmark fails on a real regression', () => {
  it('flags a slowdown beyond tolerance, passes within it', () => {
    expect(benchmarkRegressed(100, 130)).toBe(true); // +30% — regression
    expect(benchmarkRegressed(100, 105)).toBe(false); // +5% — within 10% tolerance
    expect(benchmarkRegressed(100, 80)).toBe(false); // faster — fine
  });
  it('parses a numeric measurement from benchmark output', () => {
    expect(parseBenchmark('mean: 12.5 ms')).toBe(12.5);
    expect(parseBenchmark('no number here')).toBeNull();
  });
});

describe('a11y fails on real violations', () => {
  it('flags img-without-alt, html-without-lang, and an empty button', () => {
    const html = '<html><body><img src="x.png"><button></button><a href="#">ok</a></body></html>';
    const violations = checkA11y(html).map((v) => v.rule);
    expect(violations).toContain('image-alt');
    expect(violations).toContain('html-has-lang');
    expect(violations).toContain('button-name');
  });
  it('passes accessible markup', () => {
    const html = '<html lang="en"><body><img src="x.png" alt="x"><button>Go</button></body></html>';
    expect(checkA11y(html)).toEqual([]);
  });
});
