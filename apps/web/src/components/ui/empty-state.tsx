import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/**
 * The shell's stub surfaces (module1.md §6.1): "Each stub renders a real, styled empty state
 * naming the module that fills it. Stubs are not TODO pages — a design partner sees this."
 */
export function EmptyState({
  icon: Icon,
  title,
  module,
  description,
  points,
  children,
}: {
  icon: LucideIcon;
  title: string;
  module: string;
  description: string;
  points?: string[];
  children?: React.ReactNode;
}) {
  return (
    <section className="mx-auto grid max-w-2xl gap-4 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
      <Icon aria-hidden className="mx-auto size-8 text-muted" />
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Arrives with {module}</p>
      </div>
      <p className="text-sm text-muted">{description}</p>
      {points?.length ? (
        <ul className="mx-auto grid max-w-md gap-1.5 text-left text-sm">
          {points.map((p) => (
            <li key={p} className="flex gap-2">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-muted" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </section>
  );
}
