import { SignupInput } from '@vega/contracts';
import { problems } from '@vega/shared';
import { provisionTenant } from '../provisioning.js';
import { ProblemError, router, signupProcedure } from '../trpc.js';
import { isUniqueViolation } from '../lib.js';

/**
 * Self-serve signup (implementation plan Step 7): email → tenant + workspace provisioned →
 * connector authorize stub → first run stub. Always the `free` plan; upgrades are data.
 */
export const signupRouter = router({
  provision: signupProcedure.input(SignupInput).mutation(async ({ ctx, input }) => {
    try {
      const t = await provisionTenant(ctx.deps, {
        tenantName: input.company,
        plan: 'free',
        owner: {
          email: input.email,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.password ? { password: input.password } : {}),
        },
      });
      return {
        tenantId: t.tenantId,
        workspaceId: t.workspaceId,
        slug: t.slug,
        ...(t.inviteCode ? { inviteCode: t.inviteCode } : {}),
        // The two stubs a new tenant walks through next. Module 2 and Module 4 fill them.
        next: [
          { step: 'connect', status: 'stub', detail: 'Connector authorization arrives in Module 2.' },
          { step: 'first_run', status: 'stub', detail: 'Agent runs arrive in Module 4.' },
        ],
      };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProblemError(problems.conflict('signup could not be completed'));
      throw error;
    }
  }),
});
