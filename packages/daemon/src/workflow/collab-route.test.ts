// G0 — the collab-dispatch decision, exhaustively + fail-closed. Every PARK branch is asserted (and is
// mutation-provable: delete a park and its test goes red — the park is the guarantee, not decoration).
// The load-bearing safety property: an 'auto'/local target is NEVER a collab pick, and a collab target
// only dispatches when the project opted in AND the named peer is routable AND the differ rule holds.
import { describe, expect, it } from 'vitest';
import { type CollabRouteDeps, resolveCollabRoute } from './collab-route';

const OPEN: CollabRouteDeps = { collabEnabled: true, isRoutable: () => true };

describe('resolveCollabRoute — explicit-gated, fail-closed (no silent remote routing)', () => {
  it("'auto' target ⇒ LOCAL, never collab — even with collab enabled AND a routable peer", () => {
    expect(resolveCollabRoute('auto', 'none', undefined, OPEN)).toEqual({ kind: 'local' });
  });

  it('a local provider id (codex) ⇒ LOCAL', () => {
    expect(resolveCollabRoute('codex', 'none', undefined, OPEN)).toEqual({ kind: 'local' });
  });

  it('collab target + project NOT opted in ⇒ PARK (project gate)', () => {
    const r = resolveCollabRoute('collab:mac-1:codex', 'none', undefined, {
      collabEnabled: false,
      isRoutable: () => true,
    });
    expect(r.kind).toBe('park');
    if (r.kind === 'park') expect(r.reason).toContain('not enabled');
  });

  it('collab target + opted in but peer NOT routable ⇒ PARK (fail closed, NO local fall-back)', () => {
    const r = resolveCollabRoute('collab:mac-1:codex', 'none', undefined, {
      collabEnabled: true,
      isRoutable: () => false,
    });
    expect(r.kind).toBe('park');
    if (r.kind === 'park') expect(r.reason).toContain('not routable');
  });

  it("collab reviewer whose vendor == the engineer's (differ:'must') ⇒ PARK (differ violated)", () => {
    const r = resolveCollabRoute('collab:mac-1:codex', 'must', 'codex', OPEN);
    expect(r.kind).toBe('park');
    if (r.kind === 'park') expect(r.reason).toContain('differ');
  });

  it('malformed collab target ⇒ PARK', () => {
    expect(resolveCollabRoute('collab:onlypeer', 'none', undefined, OPEN).kind).toBe('park');
  });

  it("collab engineer target, opted in + routable (differ:'none') ⇒ collab (honored)", () => {
    expect(resolveCollabRoute('collab:mac-1:codex', 'none', undefined, OPEN)).toEqual({
      kind: 'collab',
      peerId: 'mac-1',
      vendor: 'codex',
      providerId: 'collab:mac-1:codex',
    });
  });

  it("collab reviewer with a DIFFERENT vendor from the engineer (differ:'must') ⇒ collab (honored)", () => {
    expect(resolveCollabRoute('collab:mac-1:gemini', 'must', 'codex', OPEN)).toEqual({
      kind: 'collab',
      peerId: 'mac-1',
      vendor: 'gemini',
      providerId: 'collab:mac-1:gemini',
    });
  });
});
