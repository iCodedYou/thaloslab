import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude';
import { mockAdapter } from './mock';
import { adapterFor } from './registry';

describe('registry mode-aware routing', () => {
  it('returns a PROVIDER-TAGGED mock for every provider in --mock (deterministic, zero tokens)', () => {
    // Mock invoke behavior, but tagged with the provider id so cross-provider mock runs are distinct.
    const codexMock = adapterFor('codex', 'mock');
    expect(codexMock.id).toBe('codex');
    expect(codexMock.invoke).toBe(mockAdapter.invoke);
    expect(adapterFor('mock', 'mock')).toBe(mockAdapter);
  });

  it('returns the real adapter in --live and preview', () => {
    expect(adapterFor('claude', 'live')).toBe(claudeAdapter);
    expect(adapterFor('claude', 'preview')).toBe(claudeAdapter);
  });

  it('throws for an unknown provider outside mock mode', () => {
    expect(() => adapterFor('does-not-exist', 'live')).toThrow();
  });
});
