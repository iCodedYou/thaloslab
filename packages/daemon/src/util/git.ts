// EOL-tolerant changed-files detection. This feeds BOTH the no-progress doom-loop heuristic and
// (indirectly) the path-scope reasoning, so EOL-only noise here is latent flakiness, not cosmetics.
// Layer 2 of the fix: `--ignore-cr-at-eol` so a CRLF-vs-LF-only difference produces an empty diff
// and the file is not reported. (Layer 1 is the `.gitattributes` written into each worktree.)
import { execa } from 'execa';

// Thalos-managed worktree files that must never count as agent changes.
const IGNORE_FILES: ReadonlySet<string> = new Set(['.gitattributes']);

export async function changedFiles(cwd: string): Promise<string[]> {
  try {
    // --numstat lines are "<added>\t<deleted>\t<path>" ("-\t-" for binary). With
    // --ignore-cr-at-eol an EOL-only (CRLF↔LF) change scores 0 added / 0 deleted and is dropped;
    // --name-only would NOT drop it (it lists any byte difference before content-level ignores).
    const tracked = await execa('git', ['diff', '--numstat', '--ignore-cr-at-eol'], {
      cwd,
      reject: false,
    });
    const real = tracked.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [added, deleted, ...rest] = l.split('\t');
        return { added, deleted, path: rest.join('\t') };
      })
      .filter((x) => x.added === '-' || Number(x.added) + Number(x.deleted) > 0)
      .map((x) => x.path);

    const untracked = (
      await execa('git', ['ls-files', '--others', '--exclude-standard'], { cwd, reject: false })
    ).stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const set = new Set([...real, ...untracked]);
    for (const f of IGNORE_FILES) set.delete(f);
    return [...set];
  } catch {
    return [];
  }
}
