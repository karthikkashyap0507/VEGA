-- =============================================================================
-- 0005_mcp_tools — Module 2 §5.6: tools discovered on attached MCP servers.
--
-- Unlike tool_declarations (global, generated from code), these are per tenant: each tenant
-- attaches its own servers. A row with declared_by = 'default' is governed by the conservative
-- defaults (EXTERNAL / R3 / TRUSTED / NONE, autonomy ≤ SUPERVISED); only an admin declaration
-- changes that. `published` is what the server proposed — stored, never applied on its own.
-- =============================================================================

ALTER TABLE connectors ADD CONSTRAINT connectors_id_tenant_key UNIQUE (id, tenant_id);
-- The slug is the middle segment of every tool id from a server (mcp.<slug>.<tool>), so two
-- servers in one tenant must never share one.
CREATE UNIQUE INDEX connectors_mcp_slug_unique ON connectors (tenant_id, (config->>'slug')) WHERE kind = 'mcp';

CREATE TABLE mcp_tools (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id     uuid        NOT NULL,
  tool_id          text        NOT NULL,
  name             text        NOT NULL,
  title            text        NOT NULL,
  description      text        NOT NULL DEFAULT '',
  input_schema     jsonb       NOT NULL,
  annotations      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  declared_by      text        NOT NULL DEFAULT 'default',
  declaration      jsonb,
  published        jsonb,
  declared_by_user uuid,
  declared_at      timestamptz,
  discovered_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_tools_connector_fk
    FOREIGN KEY (connector_id, tenant_id) REFERENCES connectors (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT mcp_tools_declared_by_check CHECK (declared_by IN ('default', 'admin')),
  CONSTRAINT mcp_tools_admin_has_declaration CHECK (declared_by = 'default' OR declaration IS NOT NULL),
  CONSTRAINT mcp_tools_tool_id_check CHECK (tool_id ~ '^mcp\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  UNIQUE (tenant_id, tool_id)
);
CREATE INDEX mcp_tools_connector_idx ON mcp_tools (tenant_id, connector_id);

ALTER TABLE mcp_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tools FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_tools
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_tools TO vega_app;
