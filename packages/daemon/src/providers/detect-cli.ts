// Shared provider detection + version-drift guard (SPEC §5, DECISIONS #17). Each adapter supplies a
// spec (bin, version args, a ZERO-COST auth check, its tested version prefix); the probe never spends
// tokens. The version guard warns loudly when an installed CLI is outside its tested range — the
// stream/permission contracts drift across CLI versions — and hard-fails under THALOS_STRICT_CLI_VERSION.
import { execa } from 'execa';
import type { DetectResult } from '@thaloslab/shared';
import { whichSync } from './which';

export interface CliSpec {
  bin: string;
  versionArgs: string[];
  /** Zero-cost auth check (env var / credential file existence) — never an API call. */
  authCheck: () => boolean;
  /** CLI version prefix this adapter was written + tested against. */
  testedPrefix: string;
  /** Human label for warnings. */
  label: string;
}

export async function detectCli(spec: CliSpec): Promise<DetectResult> {
  const resolved = whichSync(spec.bin);
  if (!resolved) return { installed: false, authenticated: false };
  let version: string | undefined;
  try {
    const { stdout } = await execa(resolved, spec.versionArgs, { timeout: 10_000 });
    version = stdout.trim().split('\n')[0]?.trim().split(/\s+/)[0];
  } catch {
    /* installed but the version probe failed */
  }
  return { installed: true, authenticated: spec.authCheck(), version };
}

const guarded = new Set<string>();

/** Loud warning (configurable hard-fail) when `bin`'s version is outside `testedPrefix`. Runs once per bin. */
export async function guardVersion(
  bin: string,
  testedPrefix: string,
  label: string,
): Promise<void> {
  if (guarded.has(bin)) return;
  guarded.add(bin);
  try {
    const { stdout } = await execa(bin, ['--version'], { timeout: 10_000 });
    const version = stdout.trim().split('\n')[0]?.trim().split(/\s+/)[0] ?? '';
    if (!version.startsWith(testedPrefix)) {
      process.stderr.write(
        `[thalos] WARNING: ${label} CLI ${version} is outside the tested range ${testedPrefix}x — ` +
          `output/permission parsing may drift. Set THALOS_STRICT_CLI_VERSION=1 to fail instead.\n`,
      );
      if (process.env.THALOS_STRICT_CLI_VERSION === '1') {
        throw new Error(`${label} CLI ${version} outside tested range ${testedPrefix}x`);
      }
    }
  } catch (err) {
    if (process.env.THALOS_STRICT_CLI_VERSION === '1') throw err;
  }
}

/** Test-only: reset the once-per-bin guard latch. */
export function resetVersionGuard(): void {
  guarded.clear();
}
