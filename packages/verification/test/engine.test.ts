import { describe, expect, it } from 'vitest';
import { CHECK_ORDER, verify, type Check, type CheckName } from '../src/index.js';

/** §12: verification check ordering — cheapest first, fail-fast. Blocking. */

const pass: Check = async () => ({ outcome: 'PASS', detail: 'ok' });

function recording(outcomes: Partial<Record<CheckName, 'PASS' | 'WARN' | 'ESCALATE' | 'ABORT' | 'COMPENSATE'>>) {
  const ran: CheckName[] = [];
  const checks = Object.fromEntries(
    CHECK_ORDER.map((n) => [
      n,
      async () => {
        ran.push(n);
        return { outcome: outcomes[n] ?? 'PASS', detail: `${n} said ${outcomes[n] ?? 'PASS'}` };
      },
    ]),
  ) as Record<CheckName, Check>;
  return { ran, checks };
}

describe('the check order', () => {
  it('is cheapest first, and fixed', () => {
    expect(CHECK_ORDER).toEqual(['permissions', 'policy', 'conflicts', 'exposure', 'consequence', 'groundedness']);
  });

  it('runs in that order whatever order the checks were supplied in', async () => {
    const { ran, checks } = recording({});
    const shuffled = Object.fromEntries(Object.entries(checks).reverse());
    const v = await verify('pre_commit', shuffled);
    expect(ran).toEqual([...CHECK_ORDER]);
    expect(v.outcome).toBe('PASS');
    expect(v.results.map((r) => r.check)).toEqual([...CHECK_ORDER]);
  });

  it('an ABORT stops the rest — recorded SKIPPED, never passed', async () => {
    const { ran, checks } = recording({ conflicts: 'ABORT' });
    const v = await verify('pre_commit', checks);
    expect(ran).toEqual(['permissions', 'policy', 'conflicts']);
    expect(v.outcome).toBe('ABORT');
    expect(v.reason).toBe('conflicts: conflicts said ABORT');
    expect(v.results.slice(3).map((r) => r.outcome)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);
  });

  it('ESCALATE and WARN do not stop: the approver sees everything that was found', async () => {
    const { ran, checks } = recording({ policy: 'ESCALATE', exposure: 'WARN', groundedness: 'ESCALATE' });
    const v = await verify('pre_commit', checks);
    expect(ran).toHaveLength(6);
    expect(v.outcome).toBe('ESCALATE');
    expect(v.reason).toBe('policy: policy said ESCALATE; groundedness: groundedness said ESCALATE');
  });

  it('the worst outcome wins', async () => {
    expect((await verify('pre_commit', recording({ exposure: 'WARN' }).checks)).outcome).toBe('WARN');
    expect((await verify('pre_commit', recording({ exposure: 'WARN', policy: 'ESCALATE' }).checks)).outcome).toBe('ESCALATE');
  });

  it('post-commit, a failure means compensate; pre-commit it means abort', async () => {
    expect((await verify('post_commit', recording({ consequence: 'ABORT' }).checks)).outcome).toBe('COMPENSATE');
    expect((await verify('pre_commit', recording({ consequence: 'COMPENSATE' }).checks)).outcome).toBe('ABORT');
  });

  it('a check that throws has not passed: abort before the commit, escalate after it', async () => {
    const boom: Check = async () => {
      throw new Error('classifier down');
    };
    const pre = await verify('pre_commit', { permissions: pass, exposure: boom, groundedness: pass });
    expect(pre.outcome).toBe('ABORT');
    expect(pre.reason).toMatch(/exposure: the check could not run: classifier down/);
    expect(pre.results.at(-1)!.outcome).toBe('SKIPPED');
    expect((await verify('post_commit', { consequence: boom })).outcome).toBe('ESCALATE');
  });

  it('absent checks are not reported (they do not apply to this step)', async () => {
    const v = await verify('post_commit', { consequence: pass });
    expect(v.results.map((r) => r.check)).toEqual(['consequence']);
  });
});
