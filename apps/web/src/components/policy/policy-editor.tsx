'use client';
import { useEffect, useRef } from 'react';

/**
 * The policy YAML editor (docs/module5.md §6.1, §9): CodeMirror 6 in YAML mode, with
 * autocomplete over the fields a condition may test, their enumerated values, the decision
 * vocabulary and every tool id. Validation runs on the server (the same schema the compiler
 * uses) and is shown under the editor with the path of each problem.
 *
 * CodeMirror is loaded in the browser only (it touches the DOM at import time).
 */

export interface Vocabulary {
  fields: Array<{ field: string; type: string; values?: string[]; doc: string }>;
  tools: string[];
}

const KEYWORDS = [
  { label: 'id', info: 'kebab-case, unique in this tenant' },
  { label: 'description', info: 'what the policy is for, in plain words' },
  { label: 'citation', info: 'the rule it answers to (FINRA 2210, GDPR Art. 5…)' },
  { label: 'severity', info: 'low | normal | high | critical' },
  { label: 'when', info: 'all / any / not, over fields' },
  { label: 'then', info: 'decision, approver_role, hold_window, reason' },
  { label: 'all', info: 'every condition holds' },
  { label: 'any', info: 'at least one holds' },
  { label: 'not', info: 'the condition does not hold' },
  { label: 'decision', info: 'ALLOW | ALLOW_WITH_HOLD | REQUIRE_APPROVAL | REQUIRE_DUAL_APPROVAL | DENY' },
  { label: 'approver_role', info: 'APPROVER, ADMIN, OWNER, or a role your firm names' },
  { label: 'hold_window', info: 'e.g. 2m, 15m, 1h' },
  { label: 'reason', info: 'required for DENY: shown to the person' },
  { label: 'separation_of_duties', info: 'the requester may not approve' },
];
const DECISIONS = ['ALLOW', 'ALLOW_WITH_HOLD', 'REQUIRE_APPROVAL', 'REQUIRE_DUAL_APPROVAL', 'DENY'];
const OPERATORS = ['not', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'];

export function PolicyEditor({ value, onChange, vocabulary, label }: { value: string; onChange: (v: string) => void; vocabulary: Vocabulary | undefined; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ destroy(): void; state: { doc: { toString(): string } }; dispatch(t: unknown): void } | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const vocab = useRef(vocabulary);
  vocab.current = vocabulary;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ EditorView, basicSetup }, { yaml }, { autocompletion }] = await Promise.all([import('codemirror'), import('@codemirror/lang-yaml'), import('@codemirror/autocomplete')]);
      if (cancelled || !host.current) return;
      const complete = (ctx: { matchBefore(re: RegExp): { from: number; to: number; text: string } | null; explicit: boolean; state: { doc: { lineAt(pos: number): { text: string; from: number } } }; pos: number }) => {
        const word = ctx.matchBefore(/[\w.-]*/);
        if (!word || (word.from === word.to && !ctx.explicit)) return null;
        const line = ctx.state.doc.lineAt(ctx.pos);
        const before = line.text.slice(0, ctx.pos - line.from);
        const v = vocab.current;
        // After `field:` → that field's values; after `decision:` → decisions; after `{ ` → operators.
        const fieldMatch = /([\w.]+):\s*(?:\{\s*\w+:\s*)?\[?[^:]*$/.exec(before);
        if (/decision:\s*[\w]*$/.test(before)) return { from: word.from, options: DECISIONS.map((d) => ({ label: d, type: 'enum' })) };
        if (/\{\s*[\w]*$/.test(before)) return { from: word.from, options: OPERATORS.map((o) => ({ label: o, type: 'keyword' })) };
        if (fieldMatch && before.includes(':')) {
          const f = v?.fields.find((x) => x.field === fieldMatch[1]);
          if (fieldMatch[1] === 'tool.id') return { from: word.from, options: (v?.tools ?? []).map((t) => ({ label: t, type: 'constant' })) };
          if (f?.values) return { from: word.from, options: f.values.map((x) => ({ label: x, type: 'enum', info: f.doc })) };
        }
        return {
          from: word.from,
          options: [...KEYWORDS.map((k) => ({ label: k.label, type: 'keyword', info: k.info })), ...(v?.fields ?? []).map((f) => ({ label: f.field, type: 'property', info: `${f.type} — ${f.doc}` }))],
        };
      };
      view.current = new EditorView({
        doc: value,
        parent: host.current,
        extensions: [
          basicSetup,
          yaml(),
          autocompletion({ override: [complete as never] }),
          EditorView.updateListener.of((u: { docChanged: boolean; state: { doc: { toString(): string } } }) => {
            if (u.docChanged) latest.current(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': label, 'data-testid': 'policy-editor' }),
          EditorView.theme({ '&': { fontSize: '12px', minHeight: '16rem' }, '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)' } }),
        ],
      }) as never;
    })();
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
    // The editor owns its document after mount; `value` seeds it once.
  }, []);

  // An external reset (a different policy chosen) replaces the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.toString().length, insert: value } });
  }, [value]);

  return <div ref={host} className="overflow-hidden rounded-md border border-border bg-surface" />;
}
