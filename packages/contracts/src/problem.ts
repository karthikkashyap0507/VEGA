import { z } from 'zod';

/** RFC 9457 Problem Details. `type` URIs are stable — clients branch on them, so they are API. */
export const Problem = z.object({
  type: z.string().url().or(z.literal('about:blank')),
  title: z.string(),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
});
export type Problem = z.infer<typeof Problem>;
