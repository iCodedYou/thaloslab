import { describe, expect, it } from 'vitest';
import { genId } from './id';

describe('genId', () => {
  it('produces a prefixed 12-hex id', () => {
    expect(genId('p')).toMatch(/^p_[0-9a-f]{12}$/);
  });

  it('is unique across calls', () => {
    expect(genId('p')).not.toBe(genId('p'));
  });
});
