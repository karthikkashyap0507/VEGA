import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Effect } from '@vega/contracts';
import { applyEdit, blastRadius, canMove, divergence, editableFields, nextDelay, percentile, remainingText, retryable, sagaOrder, undoable, undoStats } from '../src/index.js';

const eff = (over: Partial<Effect<unknown>> = {}): Effect<unknown> => ({ summary: 's', fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: {}, ...over });

describe('lifecycle', () => {
  it('only the listed moves are allowed; terminal states stay terminal', () => {
    expect(canMove('armed', 'executing')).toBe(true);
    expect(canMove('executing', 'armed')).toBe(true);
    expect(canMove('failed', 'executing')).toBe(true);
    for (const t of ['succeeded', 'expired', 'not_needed'] as const) expect(canMove(t, 'executing')).toBe(false);
  });

  it('refuses to undo what is pending, failed, done, running or expired — with a reason', () => {
    const now = Date.now();
    const base = { state: 'armed' as const, forwardState: 'committed' as const, ttlAt: new Date(now + 1000) };
    expect(undoable(base, now)).toEqual({ ok: true });
    expect(undoable({ ...base, forwardState: 'pending' }, now).ok).toBe(false);
    expect(undoable({ ...base, forwardState: 'failed' }, now).ok).toBe(false);
    expect(undoable({ ...base, state: 'executing' }, now).ok).toBe(false);
    expect(undoable({ ...base, ttlAt: new Date(now - 1) }, now)).toMatchObject({ ok: false, reason: expect.stringContaining('permanent') });
  });

  it('says how long the undo stays available', () => {
    const now = 0;
    expect(remainingText(new Date(89 * 86_400_000 + 3_600_000), now)).toBe('89 days');
    expect(remainingText(new Date(5 * 3_600_000), now)).toBe('5 hours');
    expect(remainingText(new Date(-1), now)).toBeNull();
  });

  it('saga order is strict reverse commitment (property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 30 }), (seqs) => {
        const rows = seqs.map((s) => ({ commitSeq: s, createdAt: new Date(0) }));
        const out = sagaOrder(rows).map((r) => r.commitSeq!);
        expect(out).toEqual([...seqs].sort((a, b) => b - a));
      }),
    );
    // An unknown-outcome action (no seq) is treated as the most recent: undone first.
    expect(sagaOrder([{ commitSeq: 5, createdAt: new Date(0) }, { commitSeq: null, createdAt: new Date(0) }])[0]!.commitSeq).toBeNull();
  });

  it('retries are bounded, and permanent errors are not retried', () => {
    expect([nextDelay(1), nextDelay(2), nextDelay(3)]).toEqual([2000, 8000, null]);
    expect(retryable('TRANSIENT')).toBe(true);
    expect(retryable('PERMISSION_DENIED')).toBe(false);
    expect(retryable('AUTH_EXPIRED')).toBe(false);
  });
});

describe('divergence', () => {
  it('identical effects do not diverge', () => {
    expect(divergence('gmail.send', eff({ externalRecipients: ['a@x.example'] }), eff({ externalRecipients: ['A@x.example'] })).severity).toBe('NONE');
  });
  it('a different recipient ABORTS; a moved conflict count is tolerated for calendar tools', () => {
    expect(divergence('gmail.send', eff({ externalRecipients: ['a@x.example'] }), eff({ externalRecipients: ['b@x.example'] })).severity).toBe('ABORT');
    expect(divergence('gcal.create', eff({ detail: { conflicts: 0 } }), eff({ detail: { conflicts: 1 } })).severity).toBe('WITHIN_TOLERANCE');
    expect(divergence('gdrive.write', eff({ detail: { bytes: 1 } }), eff({ detail: { bytes: 2 } })).severity).toBe('ABORT');
  });
  it('provider-assigned ids are never compared', () => {
    expect(divergence('gcal.create', eff({ recordsAffected: [{ system: 'gcal', id: '(new event)' }], detail: { eventId: null } }), eff({ recordsAffected: [{ system: 'gcal', id: 'e1' }], detail: { eventId: 'e1' } })).severity).toBe('NONE');
  });
});

describe('blast radius', () => {
  it('groups by effect, counts external domains, reports the weakest fidelity honestly', () => {
    const b = blastRadius([
      { nodeId: 'n1', toolId: 'gmail.search', reversibility: 'R0', holdSupported: false, effect: eff({ detail: { messages: [{ value: 1, sourceId: 's1', taint: 'UNTRUSTED' }, { value: 2, sourceId: 's2', taint: 'UNTRUSTED' }] } }) },
      { nodeId: 'n2', toolId: 'gmail.send', reversibility: 'R2', holdSupported: true, effect: eff({ externalRecipients: ['a@acme.com', 'b@contoso.com'] }) },
      { nodeId: 'n3', toolId: 'gmail.send', reversibility: 'R2', holdSupported: true, effect: eff({ externalRecipients: ['c@acme.com'] }) },
      { nodeId: 'n4', toolId: 'gcal.create', reversibility: 'R1', holdSupported: true, effect: eff({ fidelity: 'PROVIDER' }) },
      { nodeId: 'n5', toolId: 'http.request', reversibility: 'R3', holdSupported: true, effect: null, error: 'VALIDATION' },
    ]);
    expect(b.groups.map((g) => g.label)).toEqual(['call 1 external API', 'send 2 emails', 'create 1 event']);
    expect(b.groups[1]!.externalDomains).toEqual(['acme.com', 'contoso.com']);
    expect(b.reads).toEqual([{ toolId: 'gmail.search', label: '2 emails', calls: 1, items: 2 }]);
    expect(b.minFidelity).toBe('DECLARED');
    expect(b.failures).toHaveLength(1);
    expect(b.consequential).toBe(4);
  });
  it('a read-only run says so', () => {
    expect(blastRadius([{ nodeId: 'n', toolId: 'gcal.list', reversibility: 'R0', holdSupported: false, effect: eff() }])).toMatchObject({ minFidelity: 'NONE', consequential: 0 });
  });
});

describe('time-to-undo', () => {
  it('median and p99 by nearest rank, success rate, trend per day', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 99)).toBe(4);
    const day = new Date('2026-09-27T10:00:00Z');
    const s = undoStats([
      { toolId: 'gmail.send', kind: 'revoke', durationMs: 100, succeeded: true, requestedAt: day },
      { toolId: 'gmail.send', kind: 'revoke', durationMs: 300, succeeded: true, requestedAt: day },
      { toolId: 'gmail.send', kind: 'revoke', durationMs: null, succeeded: false, requestedAt: day },
    ]);
    expect(s[0]).toMatchObject({ count: 3, succeeded: 2, medianMs: 100, p99Ms: 300, trend: [{ day: '2026-09-27', medianMs: 100, count: 2 }] });
    expect(s[0]!.successRate).toBeCloseTo(2 / 3);
  });
});

describe('edit and requeue', () => {
  const send = { toolId: 'gmail.send', recipientArgs: ['to', 'cc', 'bcc'] };
  const args = { to: ['p@x.example'], subject: 'Hi', body: 'Old' };
  it('only content is editable, never who receives it', () => {
    expect(editableFields(send, args)).toEqual(['subject', 'body']);
    const r = applyEdit(send, args, { to: ['evil@x.example'] }, { userId: 'u', at: new Date(0) });
    expect(r).toMatchObject({ ok: false, problems: [expect.stringContaining('cannot be changed')] });
  });
  it('records only what changed', () => {
    const r = applyEdit(send, args, { body: 'New', subject: 'Hi' }, { userId: 'u', at: new Date(0) });
    expect(r).toMatchObject({ ok: true, args: { body: 'New' }, diff: { fields: { body: { before: 'Old', after: 'New' } } } });
    expect(applyEdit(send, args, { body: 'Old' }, { userId: 'u', at: new Date(0) })).toMatchObject({ ok: false, problems: ['nothing changed'] });
  });
});
