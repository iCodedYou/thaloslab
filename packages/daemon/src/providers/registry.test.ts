import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude';
import { mockAdapter } from './mock';
import { adapterFor } from './registry';

describe('registry mode-aware routing', () => {
  it('returns the mock adapter for EVERY provider in --mock (deterministic, zero tokens)', () => {
    expect(adapterFor('claude', 'mock')).toBe(mockAdapter);
    expect(adapterFor('codex', 'mock')).toBe(mockAdapter);
  });

  it('returns the real adapter in --live and preview', () => {
    expect(adapterFor('claude', 'live')).toBe(claudeAdapter);
    expect(adapterFor('claude', 'preview')).toBe(claudeAdapter);
  });

  it('throws for an unknown provider outside mock mode', () => {
    expect(() => adapterFor('does-not-exist', 'live')).toThrow();
  });
});
