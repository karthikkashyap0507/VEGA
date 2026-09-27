/**
 * EDIT AND REQUEUE — docs/module6.md §5.5: during a hold, a person may change the CONTENT of
 * what is about to go out; the window restarts, and the change is recorded as override
 * telemetry for Module 10 (`edit_diff`).
 *
 * Only content can be edited — never who receives it. Recipients are what the taint gate (M3)
 * and the policy engine (M5) judged; changing them is a different action, so the person revokes
 * this one and asks again. The edited call is then decided by policy again, from scratch.
 */

export const EDITABLE_FIELDS = ['subject', 'body', 'text', 'summary', 'description', 'location', 'content'] as const;
const MAX_FIELD = 200_000;

export interface EditDiff {
  toolId: string;
  /** Only the fields that changed. */
  fields: Record<string, { before: string; after: string }>;
  editedBy: string;
  editedAt: string;
}

/** The content fields of this call a person may change. */
export function editableFields(tool: { recipientArgs: readonly string[] }, args: Record<string, unknown>): string[] {
  const recipients = new Set(tool.recipientArgs.map((r) => r.split('.')[0]!));
  return EDITABLE_FIELDS.filter((f) => typeof args[f] === 'string' && !recipients.has(f));
}

export function applyEdit(
  tool: { toolId: string; recipientArgs: readonly string[] },
  args: Record<string, unknown>,
  patch: Record<string, unknown>,
  by: { userId: string; at: Date },
): { ok: true; args: Record<string, unknown>; diff: EditDiff } | { ok: false; problems: string[] } {
  const allowed = new Set(editableFields(tool, args));
  const problems: string[] = [];
  const fields: EditDiff['fields'] = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) {
      problems.push(tool.recipientArgs.some((r) => r.split('.')[0] === k) ? `${k}: who receives it cannot be changed during a hold — revoke it and ask again` : `${k}: not an editable field of ${tool.toolId}`);
      continue;
    }
    if (typeof v !== 'string') problems.push(`${k}: must be text`);
    else if (v.length > MAX_FIELD) problems.push(`${k}: longer than ${MAX_FIELD} characters`);
    else if (v !== args[k]) fields[k] = { before: String(args[k]), after: v };
  }
  if (problems.length) return { ok: false, problems };
  if (!Object.keys(fields).length) return { ok: false, problems: ['nothing changed'] };
  const next = { ...args };
  for (const [k, f] of Object.entries(fields)) next[k] = f.after;
  return { ok: true, args: next, diff: { toolId: tool.toolId, fields, editedBy: by.userId, editedAt: by.at.toISOString() } };
}
