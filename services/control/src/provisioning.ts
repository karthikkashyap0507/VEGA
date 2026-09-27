import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Logger } from '@vega/shared';
import { schema, withTenant } from '@vega/db';
import { tenantRoleTuples, workspaceCreatedTuples, type FgaClient, type TupleKey } from '@vega/authz';
import type { IdentityAdmin } from '@vega/idp';
import type { Plan } from '@vega/contracts';
import { emitEvent, isUniqueViolation, slugify } from './lib.js';

/**
 * Tenant provisioning — the self-serve path (module1.md §1.5, implementation plan Step 7).
 *
 * Built in Module 1 because every later module depends on the tenant lifecycle, and adding
 * self-serve in month nine means reworking provisioning under nine modules of code (D-09).
 *
 * THE SAME PATH FOR EVERY PLAN. An enterprise tenant provisioned by sales and a free tenant
 * from the signup form run this function; the plan is a column value, not a branch.
 *
 * No RLS bypass: the tenant id is generated here, and every insert runs under
 * withTenant(newId) — so the tenants policy's WITH CHECK (id = current_tenant_id()) admits
 * exactly this row and nothing else.
 *
 * All-or-nothing by compensation, in reverse order: tuples, rows, then the IdP organization.
 */

export interface ProvisionTenantInput {
  tenantName: string;
  slug?: string;
  plan?: Plan;
  owner: {
    email: string;
    displayName?: string;
    /** Development/tests: a password so the owner can sign in without an invite round-trip. */
    password?: string;
  };
  workspaceName?: string;
}

export interface ProvisionedTenant {
  tenantId: string;
  orgId: string;
  userId: string;
  ownerIdpSubject: string;
  workspaceId: string;
  slug: string;
  inviteCode?: string;
}

export interface ProvisioningDeps {
  identity: IdentityAdmin;
  fga: FgaClient;
  logger: Logger;
  returnInviteCodes?: boolean;
}

const MAX_SLUG_ATTEMPTS = 4;

export async function provisionTenant(
  deps: ProvisioningDeps,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const email = input.owner.email.toLowerCase();
  const baseSlug = input.slug ?? slugify(input.tenantName);
  const displayName = input.owner.displayName ?? email.split('@')[0] ?? email;
  const [givenName, ...rest] = displayName.split(/\s+/);

  const tenantId = randomUUID();
  // The identity provider's organization is an internal handle, and its names are unique across
  // the whole instance: two unrelated firms may well share a name. The tenant keeps the name as
  // entered; the organization gets it plus the tenant's id.
  const { orgId } = await deps.identity.createOrganization(`${input.tenantName} · ${tenantId.slice(0, 8)}`);
  let ownerIdpSubject: string | undefined;
  let wroteTuples: TupleKey[] = [];
  let rowsWritten = false;

  try {
    ({ userId: ownerIdpSubject } = await deps.identity.createHumanUser({
      orgId,
      email,
      givenName: givenName || 'Owner',
      familyName: rest.join(' ') || '-',
      displayName,
      ...(input.owner.password ? { password: input.owner.password, emailVerified: true } : {}),
    }));

    let slug = baseSlug;
    let created: { userId: string; workspaceId: string } | undefined;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !created; attempt++) {
      try {
        created = await withTenant(tenantId, async (db) => {
          await db.insert(schema.tenants).values({
            id: tenantId,
            name: input.tenantName,
            slug,
            plan: input.plan ?? 'free',
            idpOrgId: orgId,
          });
          const [user] = await db
            .insert(schema.users)
            .values({
              tenantId,
              email,
              displayName,
              role: 'OWNER',
              idpSubject: ownerIdpSubject!,
              // Becomes `active` on first sign-in: proof the person controls the identity.
              status: 'invited',
            })
            .returning({ id: schema.users.id });
          const [ws] = await db
            .insert(schema.workspaces)
            .values({ tenantId, name: input.workspaceName ?? 'My workspace', slug: 'default' })
            .returning({ id: schema.workspaces.id });
          await db.insert(schema.workspaceMembers).values({
            tenantId,
            workspaceId: ws!.id,
            userId: user!.id,
            role: 'owner',
          });
          await db
            .update(schema.tenants)
            .set({ settings: { defaultWorkspaceId: ws!.id } })
            .where(eq(schema.tenants.id, tenantId));
          await emitEvent(db, tenantId, user!.id, 'tenant.provisioned', {
            plan: input.plan ?? 'free',
            orgId,
          });
          return { userId: user!.id, workspaceId: ws!.id };
        });
      } catch (error) {
        // Slugs are globally unique but other tenants are invisible under RLS, so a collision
        // is discovered by the constraint. Retry with a random suffix.
        if (!isUniqueViolation(error) || attempt === MAX_SLUG_ATTEMPTS - 1) throw error;
        slug = `${baseSlug}-${randomUUID().slice(0, 6)}`.slice(0, 64);
      }
    }
    rowsWritten = true;
    const { userId, workspaceId } = created!;

    wroteTuples = [
      tenantRoleTuples(tenantId, userId, 'OWNER').current,
      ...workspaceCreatedTuples({ workspaceId, tenantId, ownerUserId: userId }),
    ];
    await deps.fga.write(wroteTuples);

    const invite = input.owner.password
      ? {}
      : await deps.identity.createInviteCode(ownerIdpSubject, { returnCode: deps.returnInviteCodes ?? false });

    return {
      tenantId,
      orgId,
      userId,
      ownerIdpSubject,
      workspaceId,
      slug,
      ...(invite.code ? { inviteCode: invite.code } : {}),
    };
  } catch (error) {
    deps.logger.error({ err: error, tenantId, orgId }, 'tenant provisioning failed; compensating');
    if (wroteTuples.length) await deps.fga.write([], wroteTuples).catch(() => undefined);
    if (rowsWritten) {
      await withTenant(tenantId, (db) => db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId))).catch(
        (e: unknown) => deps.logger.error({ err: e, tenantId }, 'compensation failed: tenant rows remain'),
      );
    }
    await deps.identity
      .deleteOrganization(orgId)
      .catch((e: unknown) => deps.logger.error({ err: e, orgId }, 'compensation failed: orphaned IdP org'));
    throw error;
  }
}

export { activateInvitedUser as activateOnFirstSignIn } from '@vega/db';
