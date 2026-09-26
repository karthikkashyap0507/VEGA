import { z } from 'zod';
import { Email } from './common.js';

/** POST /v1/signup — self-serve provisioning (implementation plan Step 7). */
export const SignupInput = z.object({
  email: Email,
  company: z.string().min(1).max(200),
  displayName: z.string().max(200).optional(),
  /** Accepted only when the gateway runs with SIGNUP_ALLOW_PASSWORD (local development). */
  password: z.string().min(8).max(128).optional(),
});
export type SignupInput = z.infer<typeof SignupInput>;
