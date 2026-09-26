'use client';
import { Check, ShieldAlert, X } from 'lucide-react';
import type { ConsentView } from '@vega/contracts';
import { BRAND } from '@vega/shared/brand';

/** Scopes as the provider will show them — the raw strings, so nothing is paraphrased away. */
export function ScopeList({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return <p className="text-xs text-muted">No provider permissions.</p>;
  return (
    <ul className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <li key={s} className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-muted">
          {s.replace('https://www.googleapis.com/auth/', '')}
        </li>
      ))}
    </ul>
  );
}

/**
 * The consent transparency screen — docs/module2.md §6.2. Shown BEFORE the redirect to the
 * provider, and generated entirely from the tool declarations the server returns: there is no
 * hand-written permission prose in this component that could drift from what is granted.
 */
export function ConsentScreen({ consent }: { consent: ConsentView }) {
  return (
    <section aria-label={`Connect ${consent.connector}`} className="grid gap-3 text-sm">
      <h3 className="font-semibold">Connect {consent.connector}</h3>
      <div className="grid gap-1">
        <p className="font-medium">{BRAND.name} will be able to:</p>
        {consent.permissions.length === 0 ? <p className="text-xs text-muted">Nothing yet — enable at least one tool.</p> : null}
        <ul className="grid gap-2">
          {consent.permissions.map((p) => (
            <li key={p.toolId} className="grid gap-0.5">
              <span className="flex items-start gap-2">
                <Check aria-hidden className="mt-0.5 size-4 text-success" />
                <span>
                  {p.title} <span className="font-mono text-xs text-muted">({p.scopes.map((s) => s.split('/').pop()).join(', ') || 'no scope'})</span>
                </span>
              </span>
              {p.safeguard ? (
                <span className="ml-6 flex items-start gap-1 text-xs text-risk-medium">
                  <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {p.safeguard}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-1">
        <p className="font-medium">{BRAND.name} will NOT:</p>
        <ul className="grid gap-1">
          {consent.neverDoes.map((n) => (
            <li key={n} className="flex items-start gap-2">
              <X aria-hidden className="mt-0.5 size-4 text-risk-critical" />
              {n}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-1 border-t border-border pt-2">
        <p className="text-xs text-muted">
          These permissions come from the {consent.toolCount} tool{consent.toolCount === 1 ? '' : 's'} you enabled. The provider will ask for exactly:
        </p>
        <ScopeList scopes={consent.scopes} />
      </div>
    </section>
  );
}
