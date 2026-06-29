import { describe, expect, it } from 'vitest';
import { type Classifier, classifyTicket, keywordTriage } from './triage';

describe('keywordTriage', () => {
  it('classifies a bug report and detects no sensitive surface', () => {
    const r = keywordTriage('the export button 500s on large datasets');
    expect(r.taskType).toBe('bugfix');
    expect(r.mutating).toBe(true);
    expect(r.blastRadius).toEqual([]);
  });

  it('detects blast radius for auth/payments', () => {
    expect(keywordTriage('fix oauth login session bug').blastRadius).toContain('auth');
    expect(keywordTriage('billing charge fails on checkout').blastRadius).toContain('payments');
  });

  it('classifies a security audit as read-only', () => {
    const r = keywordTriage('run a security audit on the auth module');
    expect(r.taskType).toBe('security-audit');
    expect(r.mutating).toBe(false);
  });
});

describe('classifyTicket', () => {
  it('uses the classifier when it returns a result', async () => {
    const classifier: Classifier = () =>
      Promise.resolve({
        taskType: 'feature',
        mutating: true,
        blastRadius: ['data'],
        signalQuality: 'objective',
        regressionSurface: 'high',
      });
    const r = await classifyTicket('anything', '', classifier);
    expect(r.taskType).toBe('feature');
    expect(r.blastRadius).toEqual(['data']);
  });

  it('falls back to keyword triage when the classifier returns null or throws', async () => {
    expect((await classifyTicket('fix the crash', '', () => Promise.resolve(null))).taskType).toBe(
      'bugfix',
    );
    expect(
      (await classifyTicket('fix the crash', '', () => Promise.reject(new Error('llm down'))))
        .taskType,
    ).toBe('bugfix');
  });
});
