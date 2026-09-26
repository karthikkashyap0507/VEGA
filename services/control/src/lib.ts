import { and, desc, lt, or, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { problems } from '@vega/shared';
import { schema, type Db } from '@vega/db';
import type { Agent, Tenant, User, Workspace } from '@vega/contracts';
import { ProblemError } from './trpc.js';

/** Row → contract mappers. Timestamps leave the control plane as ISO strings. */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toTenant(row: typeof schema.tenants.$inferSelect): Tenant & { settings: unknown } {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan as Tenant['plan'],
    region: row.region,
    retentionDays: row.retentionDays,
    status: row.status as Tenant['status'],
    createdAt: row.createdAt.toISOString(),
    settings: row.settings,
  };
}

export function toUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    displayName: row.displayName,
    role: row.role as User['role'],
    status: row.status as User['status'],
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toWorkspace(row: typeof schema.workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAgent(row: typeof schema.agents.$inferSelect): Agent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    name: row.name,
    version: row.version,
    ownerUserId: row.ownerUserId,
    idpMachineId: row.idpMachineId ?? '',
    status: row.status as Agent['status'],
    createdAt: row.createdAt.toISOString(),
  };
}

// ------------------------------------------------------------------ pagination

/**
 * Cursor pagination on (created_at DESC, id DESC) — module1.md §7.2 forbids offsets. The
 * cursor is opaque to clients but not secret: it contains nothing a caller could not already
 * read, and RLS still bounds what any cursor can reach.
 */
export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
    if (Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
    return parsed;
  } catch {
    throw new ProblemError(problems.validation([{ path: 'cursor', message: 'malformed cursor' }]));
  }
}

export function afterCursor(
  createdAt: PgColumn,
  id: PgColumn,
  cursor: Cursor | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  const at = new Date(cursor.createdAt);
  return or(lt(createdAt, at), and(eq(createdAt, at), lt(id, cursor.id)));
}

export const newestFirst = (createdAt: PgColumn, id: PgColumn) => [desc(createdAt), desc(id)];

export function page<R extends { createdAt: Date; id: string }, T>(
  rows: R[],
  limit: number,
  map: (r: R) => T,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}

// ------------------------------------------------------------------ events

/**
 * Operational event (module1.md §4). NOT the audit chain — that is the evidence plane (M7).
 * Written in the same transaction as the change it describes.
 */
export async function emitEvent(
  db: Db,
  tenantId: string,
  actorId: string | null,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(schema.platformEvents).values({ tenantId, actorId, kind, payload });
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length >= 2 ? slug : `ws-${slug || 'x'}`.slice(0, 60);
}

export function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 5 && e; i++) {
    if ((e as { code?: string }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
