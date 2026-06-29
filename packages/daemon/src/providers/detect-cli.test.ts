// Uses `node` (always installed, version like v24.x) as a real, deterministic CLI to exercise the
// version guard: in-range = silent, out-of-range = loud warn, out-of-range + strict = throw.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardVersion, resetVersionGuard } from './detect-cli';

afterEach(() => {
  resetVersionGuard();
  delete process.env.THALOS_STRICT_CLI_VERSION;
  vi.restoreAllMocks();
});

describe('guardVersion (version-drift guard)', () => {
  it('is silent when the CLI version is within the tested prefix', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await guardVersion('node', 'v', 'node'); // every node version starts with 'v'
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns loudly (but does not throw) when outside the tested range', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(guardVersion('node', 'v99.', 'node')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('outside the tested range');
  });

  it('throws when outside range AND THALOS_STRICT_CLI_VERSION=1', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env.THALOS_STRICT_CLI_VERSION = '1';
    await expect(guardVersion('node', 'v99.', 'node')).rejects.toThrow(/outside tested range/);
  });

  it('runs the probe only once per bin (latched)', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await guardVersion('node', 'v99.', 'node');
    await guardVersion('node', 'v99.', 'node'); // second call is a no-op
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
