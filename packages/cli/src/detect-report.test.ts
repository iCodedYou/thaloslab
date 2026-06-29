import type { DetectedProvider } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { formatProviders } from './detect-report';

const base: Omit<DetectedProvider, 'installed' | 'authenticated'> = {
  id: 'claude',
  kind: 'local',
  displayName: 'Claude Code',
  version: '2.1.0',
  lastChecked: 0,
};

describe('formatProviders', () => {
  it('marks an installed + authenticated provider ready (with version)', () => {
    const out = formatProviders([{ ...base, installed: true, authenticated: true }]);
    expect(out).toContain('ready');
    expect(out).toContain('2.1.0');
  });

  it('marks installed-but-unauthenticated as needs login', () => {
    expect(formatProviders([{ ...base, installed: true, authenticated: false }])).toContain(
      'needs login',
    );
  });

  it('marks a missing provider not found', () => {
    expect(formatProviders([{ ...base, installed: false, authenticated: false }])).toContain(
      'not found',
    );
  });

  it('reports none for an empty list', () => {
    expect(formatProviders([])).toBe('none detected');
  });
});
