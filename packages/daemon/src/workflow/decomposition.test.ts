import { describe, expect, it } from 'vitest';
import { type WorkItem, outOfSeam, parseDecomposition, seamsDisjoint } from './decomposition';

describe('parseDecomposition (untrusted architect output)', () => {
  it('extracts a JSON array of work items from surrounding prose', () => {
    const raw = 'Here is the plan:\n[{"seamPaths":["src/a"],"summary":"A"}]\nDone.';
    expect(parseDecomposition(raw)).toEqual([{ seamPaths: ['src/a'], summary: 'A' }]);
  });
  it('rejects items with no seam paths, non-string paths, or an empty array', () => {
    expect(parseDecomposition('[]')).toBeNull();
    expect(parseDecomposition('[{"seamPaths":[]}]')).toBeNull();
    expect(parseDecomposition('[{"seamPaths":[1]}]')).toBeNull();
    expect(parseDecomposition('not json')).toBeNull();
  });
});

describe('seamsDisjoint (the untrusted-partition guard)', () => {
  const items = (paths: string[][]): WorkItem[] => paths.map((p) => ({ seamPaths: p }));
  it('true when lanes own non-overlapping paths', () => {
    expect(seamsDisjoint(items([['src/a'], ['src/b'], ['src/c']]))).toBe(true);
  });
  it('false on exact overlap', () => {
    expect(seamsDisjoint(items([['src/a'], ['src/a']]))).toBe(false);
  });
  it('false on prefix overlap (one lane nested under another)', () => {
    expect(seamsDisjoint(items([['src/a'], ['src/a/inner.ts']]))).toBe(false);
  });
});

describe('outOfSeam (path-ownership audit)', () => {
  it('flags changed files outside the declared seam', () => {
    expect(outOfSeam(['src/a/x.ts', 'src/b/y.ts'], ['src/a'])).toEqual(['src/b/y.ts']);
  });
  it('passes when every change is within the seam (exact or nested)', () => {
    expect(outOfSeam(['src/a', 'src/a/x.ts'], ['src/a'])).toEqual([]);
  });
});
