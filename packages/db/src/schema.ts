import {
  bigserial,
  boolean,
  customType,
  inet,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * drizzle-orm/pg-core has no `bytea` helper. The secret vault stores raw ciphertext, so
 * define it once here rather than reaching for text + base64, which would double the
 * stored size and add an encoding step on every read.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Drizzle schema — the typed query surface.
 *
 * Table DDL and RLS live in packages/db/migrations/*.sql, which is the source of truth for
 * the database. This file mirrors it for type-safe queries. `test/coverage.test.ts` asserts
 * the two do not drift, in the direction that matters: every table in the database has RLS
 * enabled AND forced.
 */

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  region: text('region').notNull().default('eu-west-1'),
  retentionDays: integer('retention_days').notNull().default(400),
  idpOrgId: text('idp_org_id'),
  billingRef: text('billing_ref'),
  settings: jsonb('settings').notNull().default({}),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    role: text('role').notNull().default('MEMBER'),
    idpSubject: text('idp_subject').unique(),
    status: text('status').notNull().default('invited'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('users_email_unique_per_tenant').on(t.tenantId, t.email), index('users_tenant_idx').on(t.tenantId)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    settings: jsonb('settings').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('workspaces_slug_unique_per_tenant').on(t.tenantId, t.slug)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull().default('member'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    specJson: jsonb('spec_json').notNull().default({}),
    ownerUserId: uuid('owner_user_id').notNull(),
    /** Zitadel machine user — an agent is a principal in its own right (module1.md §5.5). */
    idpMachineId: text('idp_machine_id'),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('agents_name_version_unique').on(t.workspaceId, t.name, t.version)],
);

/** Global reference data. Deliberately NOT tenant-scoped (decision D-09). */
export const planEntitlements = pgTable('plan_entitlements', {
  plan: text('plan').primaryKey(),
  limits: jsonb('limits').notNull(),
  exposed: jsonb('exposed').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const secretRefs = pgTable('secret_refs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  kmsKeyId: text('kms_key_id').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  authTag: bytea('auth_tag').notNull(),
  meta: jsonb('meta').notNull().default({}),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Operational telemetry. NOT the audit chain — that is the evidence plane (M7), and signed. */
export const platformEvents = pgTable('platform_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id'),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Browser sessions (module1.md §8.1). The cookie holds an opaque token; only its SHA-256 is
 * stored. Upstream IdP tokens are envelope-encrypted as a single blob.
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  previousTokenHash: bytea('previous_token_hash'),
  previousValidUntil: timestamp('previous_valid_until', { withTimezone: true }),
  idpWrappedDek: bytea('idp_wrapped_dek'),
  idpCiphertext: bytea('idp_ciphertext'),
  idpIv: bytea('idp_iv'),
  idpAuthTag: bytea('idp_auth_tag'),
  idpKmsKeyId: text('idp_kms_key_id'),
  idpCheckedAt: timestamp('idp_checked_at', { withTimezone: true }).notNull().defaultNow(),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
});

/** module1.md §7.2 — every mutating endpoint accepts Idempotency-Key; stored 24h. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: bytea('request_hash').notNull(),
    state: text('state').notNull().default('in_progress'),
    statusCode: integer('status_code'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.principalId, t.key] })],
);

// ============================ Module 2: connectors =============================

export const connectors = pgTable('connectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  workspaceId: uuid('workspace_id'),
  kind: text('kind').notNull(),
  displayName: text('display_name').notNull(),
  accountRef: text('account_ref'),
  ownerUserId: uuid('owner_user_id').notNull(),
  scopesGranted: text('scopes_granted').array().notNull().default([]),
  scopesRequired: text('scopes_required').array().notNull().default([]),
  enabledTools: text('enabled_tools').array().notNull().default([]),
  config: jsonb('config').notNull().default({}),
  secretRefId: uuid('secret_ref_id'),
  status: text('status').notNull().default('pending'),
  healthJson: jsonb('health_json').notNull().default({}),
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** GLOBAL projection of the TypeScript declarations. Generated from code, never hand-edited. */
export const toolDeclarations = pgTable('tool_declarations', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectorKind: text('connector_kind').notNull(),
  toolId: text('tool_id').notNull(),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  scopes: text('scopes').array().notNull(),
  egressClass: text('egress_class').notNull(),
  reversibility: text('reversibility').notNull(),
  maxTaint: text('max_taint').notNull(),
  outputTaint: text('output_taint').notNull(),
  idempotency: text('idempotency').notNull(),
  sensitivityHint: integer('sensitivity_hint').notNull(),
  holdSupported: boolean('hold_supported').notNull(),
  simulateFidelity: text('simulate_fidelity').notNull(),
  compensatorRef: text('compensator_ref'),
  recipientArgs: text('recipient_args').array().notNull(),
  argsSchema: jsonb('args_schema').notNull(),
  effectSchema: jsonb('effect_schema').notNull(),
  costHint: jsonb('cost_hint'),
  certifiedAt: timestamp('certified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const toolInvocations = pgTable('tool_invocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  connectorId: uuid('connector_id').notNull(),
  toolId: text('tool_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  argsDigest: text('args_digest').notNull(),
  state: text('state').notNull().default('in_flight'),
  responseRef: text('response_ref'),
  effectJson: jsonb('effect_json'),
  errorCode: text('error_code'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const connectorEvents = pgTable('connector_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  connectorId: uuid('connector_id').notNull(),
  kind: text('kind').notNull(),
  detail: jsonb('detail').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mcpTools = pgTable('mcp_tools', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  connectorId: uuid('connector_id').notNull(),
  toolId: text('tool_id').notNull(),
  name: text('name').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  inputSchema: jsonb('input_schema').notNull(),
  annotations: jsonb('annotations').notNull().default({}),
  declaredBy: text('declared_by').notNull().default('default'),
  declaration: jsonb('declaration'),
  published: jsonb('published'),
  declaredByUser: uuid('declared_by_user'),
  declaredAt: timestamp('declared_at', { withTimezone: true }),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
});

export const TENANT_SCOPED_TABLES = [
  'tenants',
  'users',
  'workspaces',
  'workspace_members',
  'agents',
  'secret_refs',
  'platform_events',
  'sessions',
  'idempotency_keys',
  'connectors',
  'tool_invocations',
  'connector_events',
  'mcp_tools',
] as const;

/** Not tenant-scoped, and each needs a reason recorded here — see coverage.test.ts. */
export const GLOBAL_TABLES: Record<string, string> = {
  plan_entitlements: 'Global reference data; tiers are data, not conditionals (D-09).',
  tool_declarations: 'Projection of the code-defined tool declarations; identical for every tenant (module2.md §4).',
  _migrations: 'System ledger; the application role has no grants on it.',
};
