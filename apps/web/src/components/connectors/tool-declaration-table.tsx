import type { ToolDeclarationRecord } from '@vega/contracts';
import { Badge } from '@/components/ui/badge';
import { Table, Td, Th } from '@/components/ui/table';
import { ReversibilityBadge } from './reversibility-badge';
import { ScopeList } from './consent-screen';

/**
 * Tool declarations for procurement readers (docs/module2.md §6.3) — reused by the audit
 * explorer in Module 7. Every column is a field of the declaration, explained in plain words.
 */
const EGRESS: Record<string, string> = {
  INTERNAL: 'Stays inside your organization',
  EXTERNAL: 'Reaches people or systems outside your organization',
  PUBLIC: 'Talks to the public internet',
};
const TAINT: Record<string, string> = {
  TRUSTED: 'Acts only on instructions from you, never on content it read',
  ORG: 'May use content from inside your organization',
  UNTRUSTED: 'May use content from anywhere',
};
const FIDELITY: Record<string, string> = {
  PROVIDER: 'Preview computed by the provider itself',
  DERIVED: 'Preview derived from current state',
  DECLARED: 'Preview is a description only — effect cannot be predicted',
};

export function ToolDeclarationTable({
  tools,
  extra,
}: {
  tools: ToolDeclarationRecord[];
  extra?: (t: ToolDeclarationRecord) => React.ReactNode;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Tool</Th>
          <Th>Reversibility</Th>
          <Th>Reach</Th>
          <Th>Instructions it may act on</Th>
          <Th>Preview</Th>
          <Th>Undo</Th>
          <Th>Scopes</Th>
          {extra ? <Th /> : null}
        </tr>
      </thead>
      <tbody>
        {tools.map((t) => (
          <tr key={`${t.toolId}@${t.version}`}>
            <Td>
              <div className="grid">
                <span className="font-medium">{t.title}</span>
                <span className="font-mono text-xs text-muted">{t.toolId}</span>
              </div>
            </Td>
            <Td>
              <ReversibilityBadge value={t.reversibility} />
              {t.holdSupported ? <div className="mt-1 text-xs text-muted">Held before release</div> : null}
            </Td>
            <Td className="text-xs">
              <Badge tone={t.egressClass === 'INTERNAL' ? 'neutral' : 'info'}>{t.egressClass}</Badge>
              <div className="mt-1 text-muted">{EGRESS[t.egressClass]}</div>
            </Td>
            <Td className="text-xs">
              <Badge tone={t.maxTaint === 'TRUSTED' ? 'success' : 'neutral'}>{t.maxTaint}</Badge>
              <div className="mt-1 text-muted">{TAINT[t.maxTaint]}</div>
            </Td>
            <Td className="text-xs text-muted">{FIDELITY[t.simulateFidelity]}</Td>
            <Td className="text-xs">
              {t.compensatorRef ? <span className="font-mono">{t.compensatorRef}</span> : <span className="text-muted">{t.reversibility === 'R0' ? '—' : 'None'}</span>}
            </Td>
            <Td>
              <ScopeList scopes={t.scopes} />
            </Td>
            {extra ? <Td className="text-right">{extra(t)}</Td> : null}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
