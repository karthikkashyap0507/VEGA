/**
 * APPROVE WITH EDITS — docs/module8.md §5.5, §8.3. "The single most valuable column in the
 * product": WHAT the approver changed, captured STRUCTURALLY — one entry per changed field, with
 * its path, before and after — never as a rendered string, so Module 10 can group edits by field.
 *
 * Unlike a hold's edit (Module 6: content only), an approver may change any argument; the edited
 * call is then decided by policy again, and a higher risk tier means it needs approving again.
 */

export interface FieldChange {
  path: string;
  op: 'changed' | 'added' | 'removed';
  before: unknown;
  after: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const join = (base: string, k: string | number) => (typeof k === 'number' ? `${base}[${k}]` : base ? `${base}.${k}` : k);

export function structuralDiff(before: unknown, after: unknown, path = ''): FieldChange[] {
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => {
      if (!(k in after)) return [{ path: join(path, k), op: 'removed' as const, before: before[k], after: null }];
      if (!(k in before)) return [{ path: join(path, k), op: 'added' as const, before: null, after: after[k] }];
      return structuralDiff(before[k], after[k], join(path, k));
    });
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: FieldChange[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (i >= after.length) out.push({ path: join(path, i), op: 'removed', before: before[i], after: null });
      else if (i >= before.length) out.push({ path: join(path, i), op: 'added', before: null, after: after[i] });
      else out.push(...structuralDiff(before[i], after[i], join(path, i)));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: path || '(root)', op: 'changed', before, after }];
}

/** The approver's edits applied: top-level fields replaced by the patch. */
export function applyApprovalEdits(args: Record<string, unknown>, patch: Record<string, unknown>): { args: Record<string, unknown>; diff: FieldChange[] } {
  const next = { ...args, ...patch };
  return { args: next, diff: structuralDiff(args, next) };
}
