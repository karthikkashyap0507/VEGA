-- =============================================================================
-- 0010_evidence — Module 7's one need in the PRIMARY database (docs/module7.md §7)
--
-- The evidence itself lives in the separate evidence instance (evidence-migrations/0001_chain).
-- What the primary database adds is a single resolver: the published anchors are addressed by
-- tenant slug (`/.well-known/vega/anchors/<slug>`, unauthenticated), and an unauthenticated
-- request has no tenant context. The vega_auth pattern (0002): a SECURITY DEFINER function
-- owned by a NOLOGIN role, returning an id and nothing else.
-- =============================================================================

GRANT SELECT (slug) ON tenants TO vega_auth;

CREATE FUNCTION evidence_tenant_by_slug(p_slug text)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.id FROM tenants t WHERE t.slug = p_slug
$$;

COMMENT ON FUNCTION evidence_tenant_by_slug(text) IS
  'Public anchors: a tenant slug -> its id. Slugs are public (they are in URLs); the id lets the '
  'control plane ask the evidence plane for that tenant''s published tree heads, which are public too.';

ALTER FUNCTION evidence_tenant_by_slug(text) OWNER TO vega_auth;
REVOKE ALL ON FUNCTION evidence_tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence_tenant_by_slug(text) TO vega_app;
