'use client';
import { useMemo, useState } from 'react';
import { TAINT, type Taint } from './taint';

export interface GraphNode {
  valueRef: string;
  op: string;
  taint: Taint;
  dataTaint: Taint;
  nodeId: string | null;
  sourceIds: string[];
  step: number;
}

/**
 * Provenance graph viewer — module3.md §8.3. Sources → derivations → actions as a layered DAG,
 * nodes coloured (and labelled) by taint. Selecting a node highlights everything it was derived
 * from — the path that explains a gate decision. Used by approvals (M8) and the audit explorer
 * (M7).
 */
export function ProvenanceGraph({ nodes, edges, highlight }: { nodes: GraphNode[]; edges: Array<{ from: string; to: string }>; highlight?: string }) {
  // One node per value (emit rows repeat a value); drop pure pass-throughs to keep it readable.
  const uniq = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of nodes) if (!m.has(n.valueRef)) m.set(n.valueRef, n);
    return [...m.values()];
  }, [nodes]);
  const parents = useMemo(() => {
    const p = new Map<string, string[]>();
    for (const e of edges) if (e.from !== e.to) p.set(e.to, [...(p.get(e.to) ?? []), e.from]);
    return p;
  }, [edges]);
  const depth = useMemo(() => {
    const d = new Map<string, number>();
    for (const n of uniq) d.set(n.valueRef, Math.max(0, ...(parents.get(n.valueRef) ?? []).map((x) => (d.get(x) ?? 0) + 1)));
    return d;
  }, [uniq, parents]);
  const [selected, setSelected] = useState<string | undefined>(highlight);
  const lineage = useMemo(() => {
    const out = new Set<string>();
    const walk = (v: string) => {
      if (out.has(v)) return;
      out.add(v);
      for (const p of parents.get(v) ?? []) walk(p);
    };
    if (selected) walk(selected);
    return out;
  }, [selected, parents]);

  const cols = new Map<number, GraphNode[]>();
  for (const n of uniq) cols.set(depth.get(n.valueRef)!, [...(cols.get(depth.get(n.valueRef)!) ?? []), n]);
  const W = 120;
  const H = 34;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [c, list] of cols) list.forEach((n, i) => pos.set(n.valueRef, { x: 8 + c * W, y: 8 + i * H }));
  const width = 16 + (Math.max(0, ...cols.keys()) + 1) * W;
  const height = 16 + Math.max(1, ...[...cols.values()].map((l) => l.length)) * H;
  const sel = uniq.find((n) => n.valueRef === selected);

  return (
    <div className="grid gap-2">
      <div className="overflow-auto rounded border border-border">
        <svg width={width} height={height} role="img" aria-label={`Provenance graph with ${uniq.length} values`}>
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b || e.from === e.to) return null;
            const on = lineage.has(e.to) && lineage.has(e.from);
            return <line key={i} x1={a.x + 96} y1={a.y + 12} x2={b.x} y2={b.y + 12} stroke={on ? 'var(--foreground)' : 'var(--border)'} strokeWidth={on ? 1.6 : 1} />;
          })}
          {uniq.map((n) => {
            const p = pos.get(n.valueRef)!;
            const t = TAINT[n.taint];
            const on = !selected || lineage.has(n.valueRef);
            return (
              <g key={n.valueRef} transform={`translate(${p.x},${p.y})`} opacity={on ? 1 : 0.35} onClick={() => setSelected(n.valueRef)} style={{ cursor: 'pointer' }}>
                <title>{`${n.op} · ${n.taint}${n.dataTaint !== n.taint ? ` (data ${n.dataTaint})` : ''}${n.sourceIds.length ? `\n${n.sourceIds.join('\n')}` : ''}`}</title>
                <rect width={96} height={24} rx={4} fill="var(--surface)" stroke={t.fill} strokeWidth={n.valueRef === selected ? 2.5 : 1.5} />
                <circle cx={10} cy={12} r={4} fill={t.fill} />
                <text x={18} y={16} fontSize={10} fill="var(--foreground)">
                  {n.nodeId ? `${n.op} ${n.nodeId}` : n.op}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {sel ? (
        <p className="text-xs text-muted">
          <span className="font-medium text-foreground">{sel.op}</span> ({sel.valueRef}) is {TAINT[sel.taint].label.toLowerCase()}
          {sel.dataTaint !== sel.taint ? `; its data is ${TAINT[sel.dataTaint].label.toLowerCase()}` : ''}. Derived from {lineage.size - 1} value(s)
          {sel.sourceIds.length ? ` and ${sel.sourceIds.length} source(s): ${sel.sourceIds.join(', ')}` : ''}.
        </p>
      ) : (
        <p className="text-xs text-muted">Select a value to highlight everything it was derived from.</p>
      )}
    </div>
  );
}
