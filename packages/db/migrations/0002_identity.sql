-- =============================================================================
-- 0002_identity — sessions, idempotency, and the pre-tenant resolution path
--
-- Spec: docs/module1.md §5.5, §7.2, §8.1; implementation plan Step 3 and Step 5.
--
-- THE PROBLEM THIS FILE SOLVES
--   Every query runs under withTenant(), and RLS fails closed without a tenant context.
--   But two lookups necessarily happen BEFORE a tenant is known:
--     · sign-in:  verified IdP subject → which user, which tenant?
--     · request:  session cookie       → which session, which tenant?
--
--   The tempting answer is withSystemBypassingRls(). That hands every request path an owner
--   connection with no isolation at all, which is exactly the habit module1.md §14 warns about.
--
--   Instead: two SECURITY DEFINER functions owned by a NOLOGIN role, `vega_auth`, which holds
--   a role-scoped SELECT policy on exactly the columns these lookups need. The application
--   role can EXECUTE the functions and nothing else — it cannot SET ROLE to vega_auth, cannot
--   read through its policy, and learns only what a caller already holding a verified subject
--   or a secret session token is entitled to learn.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vega_auth') THEN
    CREATE ROLE vega_auth NOLOGIN;
  END IF;
END
$$;

-- ============================== Sessions =====================================
-- One row per browser session. The cookie carries an opaque random token; only its SHA-256
-- is stored, so a database read does not yield a usable credential.
--
-- Rotation: the token is replaced on use once it is older than the rotation interval. The
-- previous hash stays valid for a short grace window (concurrent requests from one page load),
-- after which presenting it is treated as token theft and the whole session is revoked.
CREATE TABLE sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              uuid        NOT NULL,
  token_hash           bytea       NOT NULL UNIQUE,
  previous_token_hash  bytea       UNIQUE,
  previous_valid_until timestamptz,
  -- Upstream IdP tokens (refresh + id_token hint), envelope-encrypted as one JSON blob.
  -- Used to re-check the user at the IdP on rotation, and for RP-initiated logout.
  idp_wrapped_dek      bytea,
  idp_ciphertext       bytea,
  idp_iv               bytea,
  idp_auth_tag         bytea,
  idp_kms_key_id       text,
  idp_checked_at       timestamptz NOT NULL DEFAULT now(),
  user_agent           text,
  ip                   inet,
  created_at           timestamptz NOT NULL DEFAULT now(),
  rotated_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  -- Token expiry (short) and session expiry (absolute, never extended by rotation).
  expires_at           timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoke_reason        text,
  CONSTRAINT sessions_user_fk
    FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sessions_expiry_order CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX sessions_tenant_user_idx ON sessions (tenant_id, user_id);

-- ============================== Idempotency ==================================
-- module1.md §7.2: every mutating endpoint accepts Idempotency-Key; stored 24h.
-- Keyed per tenant AND principal, so one caller cannot replay another's response by
-- guessing their key.
CREATE TABLE idempotency_keys (
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  principal_id  uuid        NOT NULL,
  key           text        NOT NULL,
  method        text        NOT NULL,
  path          text        NOT NULL,
  request_hash  bytea       NOT NULL,
  state         text        NOT NULL DEFAULT 'in_progress',
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, principal_id, key),
  CONSTRAINT idempotency_keys_state_check CHECK (state IN ('in_progress', 'completed')),
  CONSTRAINT idempotency_keys_key_len CHECK (char_length(key) BETWEEN 1 AND 255)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ============================== RLS ==========================================
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Role-scoped read policies for the resolver. `TO vega_auth` is what keeps these from
-- applying to the application role: permissive policies are OR-ed only for the roles
-- they name.
CREATE POLICY auth_resolver_read ON tenants  FOR SELECT TO vega_auth USING (true);
CREATE POLICY auth_resolver_read ON users    FOR SELECT TO vega_auth USING (true);
CREATE POLICY auth_resolver_read ON sessions FOR SELECT TO vega_auth USING (true);

-- Column-level: the resolver can read only what resolution needs.
GRANT USAGE ON SCHEMA public TO vega_auth;
GRANT SELECT (id, status) ON tenants TO vega_auth;
GRANT SELECT (id, tenant_id, role, status, idp_subject) ON users TO vega_auth;
GRANT SELECT (id, tenant_id, user_id, token_hash, previous_token_hash, previous_valid_until,
              expires_at, absolute_expires_at, revoked_at) ON sessions TO vega_auth;

-- ============================== Resolver functions ===========================
-- search_path is pinned: a SECURITY DEFINER function that resolves names through a
-- caller-controlled search_path can be made to run someone else's code.

CREATE FUNCTION auth_resolve_subject(p_subject text)
  RETURNS TABLE (tenant_id uuid, user_id uuid, role text, user_status text, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT u.tenant_id, u.id, u.role, u.status, t.status
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE u.idp_subject = p_subject
$$;

COMMENT ON FUNCTION auth_resolve_subject(text) IS
  'Sign-in resolution: VERIFIED IdP subject -> (tenant, user). The caller must have verified '
  'the id_token first; the subject is the only input and it is never taken from a request.';

CREATE FUNCTION auth_resolve_session(p_token_hash bytea)
  RETURNS TABLE (
    session_id uuid, tenant_id uuid, user_id uuid, matched text,
    previous_valid_until timestamptz, expires_at timestamptz,
    absolute_expires_at timestamptz, revoked_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.tenant_id, s.user_id,
         CASE WHEN s.token_hash = p_token_hash THEN 'current' ELSE 'previous' END,
         s.previous_valid_until, s.expires_at, s.absolute_expires_at, s.revoked_at
    FROM sessions s
   WHERE s.token_hash = p_token_hash OR s.previous_token_hash = p_token_hash
$$;

COMMENT ON FUNCTION auth_resolve_session(bytea) IS
  'Request resolution: SHA-256 of a session token -> (session, tenant, user). Knowing the '
  'hash requires holding the token, which is the credential.';

ALTER FUNCTION auth_resolve_subject(text) OWNER TO vega_auth;
ALTER FUNCTION auth_resolve_session(bytea) OWNER TO vega_auth;

REVOKE ALL ON FUNCTION auth_resolve_subject(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_subject(text) TO vega_app;
GRANT EXECUTE ON FUNCTION auth_resolve_session(bytea) TO vega_app;

-- New tables pick up vega_app DML through the default privileges set in 0001.
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, idempotency_keys TO vega_app;
