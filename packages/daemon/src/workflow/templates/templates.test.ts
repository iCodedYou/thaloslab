// The 5 Phase-2 templates are DATA and selectable by triage type, with the gate shapes SPEC §7 calls
// for (security-audit is read-only; feature/refactor fan out; optimization is benchmark-gated).
import { describe, expect, it } from 'vitest';
import { allTemplates, selectTemplate } from './index';

describe('workflow template registry', () => {
  it('maps each task type to its template', () => {
    expect(selectTemplate('feature').id).toBe('feature');
    expect(selectTemplate('security-audit').id).toBe('security-audit');
    expect(selectTemplate('optimization').id).toBe('optimization');
    expect(selectTemplate('redesign').id).toBe('redesign');
    expect(selectTemplate('refactor').id).toBe('refactor');
    expect(selectTemplate('bugfix').id).toBe('bug-fix');
  });

  it('feature/refactor fan out engineers from the architect', () => {
    for (const id of ['feature', 'refactor']) {
      const t = selectTemplate(id === 'feature' ? 'feature' : 'refactor');
      const arch = t.stages.find((s) => s.role === 'architect');
      expect(arch?.fanOut?.childStageId).toBe('impl');
      // the integrate barrier depends on the fan-out child stage
      expect(t.stages.some((s) => s.dependsOn.includes('impl'))).toBe(true);
    }
  });

  it('security-audit is read-only (no build/integrate back half) and runs a real security gate', () => {
    const t = selectTemplate('security-audit');
    expect(t.mutating).toBe(false);
    expect(t.stages.some((s) => s.role === 'integrator')).toBe(false);
    expect(t.gates.some((g) => g.checks?.includes('security'))).toBe(true);
  });

  it('optimization is benchmark-gated; redesign declares a11y + visual-diff', () => {
    expect(selectTemplate('optimization').gates.some((g) => g.checks?.includes('benchmark'))).toBe(
      true,
    );
    const redesignChecks = selectTemplate('redesign').gates.flatMap((g) => g.checks ?? []);
    expect(redesignChecks).toContain('a11y');
    expect(redesignChecks).toContain('visual-diff');
  });

  it('every template id is unique', () => {
    const ids = allTemplates().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
