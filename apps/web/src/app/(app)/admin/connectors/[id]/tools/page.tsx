'use client';
import { useParams } from 'next/navigation';
import { ToolDeclarationTable } from '@/components/connectors/tool-declaration-table';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useCan } from '@/lib/me';
import { keys, useAction, useConnector, useMcpTools, useTools } from '@/lib/queries';

/**
 * Tool inspector — docs/module2.md §6.3. Written for the compliance officer reading it during
 * procurement: every column is a declared, enforced property, not a description.
 */
function McpActions({ connectorId, toolId, declaredBy, hasProposal }: { connectorId: string; toolId: string; declaredBy: string; hasProposal: boolean }) {
  const can = useCan();
  const adopt = useAction(
    () => api.put(`/v1/mcp/servers/${connectorId}/tools/${encodeURIComponent(toolId)}/declaration`, { adoptPublished: true }),
    [keys.mcpTools(connectorId)],
  );
  return (
    <div className="grid justify-items-end gap-1">
      {declaredBy === 'admin' ? <Badge tone="success">Declared</Badge> : <Badge tone="danger">Undeclared · SUPERVISED cap</Badge>}
      {declaredBy === 'default' && hasProposal && can('connectors.manage') ? (
        <Button size="sm" variant="secondary" onClick={() => adopt.mutate(undefined)} disabled={adopt.isPending}>
          Adopt server’s declaration
        </Button>
      ) : null}
      <ErrorText error={adopt.error} />
    </div>
  );
}

export default function ToolsInspector() {
  const { id } = useParams<{ id: string }>();
  const c = useConnector(id);
  const isMcp = c.data?.kind === 'mcp';
  const builtin = useTools(c.data && !isMcp ? { kind: c.data.kind } : {});
  const mcp = useMcpTools(id, isMcp);
  if (!c.data) return <ErrorText error={c.error} />;
  const rows = isMcp ? (mcp.data ?? []).map((t) => t.effective) : (builtin.data ?? []).filter((t) => t.connectorKind === c.data!.kind);
  const byId = new Map((mcp.data ?? []).map((t) => [t.toolId, t]));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Tool declarations</CardTitle>
          <CardDescription>
            {isMcp
              ? 'Discovered on the MCP server. Until declared, each is treated as irreversible, external and approval-required. The server’s own hints are never trusted.'
              : 'Declared in code, checked at build time, and enforced at runtime and in the database.'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-0 py-0">
        <ToolDeclarationTable
          tools={rows}
          {...(isMcp
            ? {
                extra: (t) => {
                  const row = byId.get(t.toolId);
                  return row ? <McpActions connectorId={id} toolId={t.toolId} declaredBy={row.declaredBy} hasProposal={Boolean(row.published)} /> : null;
                },
              }
            : {})}
        />
        <ErrorText error={builtin.error ?? mcp.error} />
      </CardContent>
    </Card>
  );
}
