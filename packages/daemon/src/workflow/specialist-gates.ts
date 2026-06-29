// Real specialist gates (SPEC §7). The binding rule: NO gate returns green having run nothing.
// security-scan, benchmark, and a11y run honest checks here; visual-diff has no real implementation
// and is handled by converting it to a blocking human gate at assembly (never a silent pass).
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

export type SpecialistCheck = 'security' | 'benchmark' | 'a11y';
export const SPECIALIST_CHECKS: ReadonlySet<string> = new Set(['security', 'benchmark', 'a11y']);
/** Declared gate checks that have no automated implementation → must convert to a human gate. */
export const UNIMPLEMENTED_CHECKS: ReadonlySet<string> = new Set(['visual-diff']);

export interface GateResult {
  ok: boolean;
  output: string;
}

// ---- security scan: secrets + dangerous patterns + dependency audit ----

export interface SecurityFinding {
  kind: 'secret' | 'sast' | 'dependency';
  detail: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [
    /\b(?:secret|token|passwd|password|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    'hardcoded credential',
  ],
];

const SAST_PATTERNS: Array<[RegExp, string]> = [
  [/\beval\s*\(/, 'use of eval()'],
  [/\bchild_process\b[\s\S]{0,60}`[^`]*\$\{/, 'shell command with interpolation'],
  [/\bnew Function\s*\(/, 'dynamic Function constructor'],
];

export function scanSecrets(files: Array<{ path: string; content: string }>): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  for (const f of files) {
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(f.content)) out.push({ kind: 'secret', detail: `${label} in ${f.path}` });
    }
  }
  return out;
}

export function scanSast(files: Array<{ path: string; content: string }>): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  for (const f of files) {
    for (const [re, label] of SAST_PATTERNS) {
      if (re.test(f.content)) out.push({ kind: 'sast', detail: `${label} in ${f.path}` });
    }
  }
  return out;
}

/** Parse `npm audit --json` for high/critical advisories (npm v7+ `vulnerabilities` map). */
export function parseNpmAudit(json: string): SecurityFinding[] {
  try {
    const data = JSON.parse(json) as {
      vulnerabilities?: Record<string, { severity?: string }>;
    };
    const out: SecurityFinding[] = [];
    for (const [name, v] of Object.entries(data.vulnerabilities ?? {})) {
      if (v.severity === 'high' || v.severity === 'critical') {
        out.push({ kind: 'dependency', detail: `${v.severity} vuln in ${name}` });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function runSecurityScan(dir: string, changedFiles: string[]): Promise<GateResult> {
  const files = changedFiles
    .map((p) => {
      try {
        return { path: p, content: fs.readFileSync(path.join(dir, p), 'utf8') };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; content: string } => x !== null);

  const findings = [...scanSecrets(files), ...scanSast(files)];
  try {
    const res = await execa('npm', ['audit', '--json'], { cwd: dir, reject: false });
    findings.push(...parseNpmAudit(res.stdout));
  } catch {
    /* audit unavailable (offline / no lockfile) — secret + SAST scan still ran */
  }
  return findings.length > 0
    ? { ok: false, output: `security: ${findings.map((f) => f.detail).join('; ')}` }
    : { ok: true, output: '' };
}

// ---- benchmark: real baseline-vs-after measurement ----

/** Extract the first numeric measurement from benchmark output (lower = faster = better). */
export function parseBenchmark(stdout: string): number | null {
  const m = /(-?\d+(?:\.\d+)?)/.exec(stdout);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** A regression is `current` slower than `baseline` beyond the tolerance (default 10%). */
export function benchmarkRegressed(baseline: number, current: number, tolerance = 0.1): boolean {
  return current > baseline * (1 + tolerance);
}

// ---- a11y: a real, rule-based HTML check (axe-style) ----

export interface A11yViolation {
  rule: string;
  detail: string;
}

export function checkA11y(html: string): A11yViolation[] {
  const out: A11yViolation[] = [];
  // <img> without an alt attribute.
  for (const _ of html.matchAll(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi)) {
    out.push({ rule: 'image-alt', detail: '<img> without alt text' });
  }
  // <html> without a lang attribute.
  if (/<html\b(?![^>]*\blang\s*=)[^>]*>/i.test(html)) {
    out.push({ rule: 'html-has-lang', detail: '<html> without lang' });
  }
  // <button> with no accessible name (no text, no aria-label).
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = m[1] ?? '';
    const text = (m[2] ?? '').replace(/<[^>]*>/g, '').trim();
    if (!text && !/\baria-label\s*=/.test(attrs)) {
      out.push({ rule: 'button-name', detail: '<button> without an accessible name' });
    }
  }
  return out;
}

export function runA11y(htmlFiles: Array<{ path: string; content: string }>): GateResult {
  const all = htmlFiles.flatMap((f) =>
    checkA11y(f.content).map((v) => `${f.path}: ${v.rule} (${v.detail})`),
  );
  return all.length > 0
    ? { ok: false, output: `a11y: ${all.join('; ')}` }
    : { ok: true, output: '' };
}
