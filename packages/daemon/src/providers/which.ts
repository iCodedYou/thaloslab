// Cross-platform binary resolution. On Windows, honors PATHEXT (.exe/.cmd/.bat) and resolves
// from non-standard PATH dirs (the Claude CLI here lives in ~/.local/bin\claude.exe).
import fs from 'node:fs';
import path from 'node:path';

export function whichSync(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    const base = path.join(dir, bin);
    // Try the literal name first (covers POSIX and already-suffixed names), then each ext.
    const candidates = isWin ? [base, ...exts.map((e) => base + e)] : [base];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here — keep looking
      }
    }
  }
  return null;
}
