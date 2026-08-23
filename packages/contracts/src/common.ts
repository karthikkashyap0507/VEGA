import { z } from 'zod';

export const Uuid = z.string().uuid();
export const Email = z.string().email().max(320);
export const Slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase alphanumeric and hyphens');
export const Timestamp = z.string().datetime({ offset: true });

/** Cursor pagination. Offset pagination is never used on audit tables (module1.md §7.2). */
export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
