import { z } from 'zod';

/**
 * Extraction schemas — the SHAPES the planner plans over (docs/module3.md §7.5). The quarantined
 * extractor turns untrusted content into one of these; the result is still UNTRUSTED, but it is
 * typed, bounded and validated, so no free-form attacker text reaches a tool argument unless the
 * program deliberately routes a field there — which static validation and the gate then judge.
 *
 * Every string is length-capped and every collection bounded. Value-range checks live here too
 * (docs/module3.md §10.1): a meeting duration of 90,000 minutes is rejected, not believed.
 */

const Email = z.string().email().max(320);
const Short = (n: number) => z.string().max(n);

export const EXTRACTION_SCHEMAS = {
  MeetingRequest: z
    .object({
      fromEmail: Email.nullable(),
      fromName: Short(200).nullable(),
      subject: Short(300),
      proposedTimes: z.array(z.string().datetime({ offset: true })).max(10),
      durationMinutes: z.number().int().min(5).max(480).nullable(),
      location: Short(300).nullable(),
      agenda: Short(2000).nullable(),
    })
    .strict()
    .describe('A request to meet: who asked, when they proposed, for how long, about what.'),
  Invoice: z
    .object({
      vendor: Short(200),
      invoiceNumber: Short(100).nullable(),
      amount: z.number().min(0).max(100_000_000),
      currency: z.string().regex(/^[A-Z]{3}$/),
      dueDate: z.string().date().nullable(),
      remitToEmail: Email.nullable(),
    })
    .strict()
    .describe('An invoice: vendor, number, amount, currency, due date.'),
  Summary: z
    .object({
      text: Short(2000),
      topics: z.array(Short(80)).max(10),
      urgent: z.boolean(),
      // Present on purpose: the red-team corpus proves a field like this can never become a
      // recipient, however the extractor is manipulated into filling it.
      recipient: Email.nullable(),
    })
    .strict()
    .describe('A short neutral summary of the content, its topics, and whether it is urgent.'),
  ContactDetails: z
    .object({ name: Short(200).nullable(), email: Email.nullable(), phone: z.string().regex(/^[+0-9 ().-]{3,30}$/).nullable(), company: Short(200).nullable() })
    .strict()
    .describe('Contact details mentioned in the content.'),
  PricingQuestion: z
    .object({ product: Short(200).nullable(), quantity: z.number().int().min(0).max(1_000_000).nullable(), question: Short(1000) })
    .strict()
    .describe('A question about pricing: which product, what quantity, the question itself.'),
} as const;

export type SchemaName = keyof typeof EXTRACTION_SCHEMAS;

export class SchemaRegistry {
  private readonly schemas = new Map<string, z.ZodType>(Object.entries(EXTRACTION_SCHEMAS));

  register(name: string, schema: z.ZodType): this {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`schema names are PascalCase: ${name}`);
    if (this.schemas.has(name)) throw new Error(`schema ${name} registered twice`);
    this.schemas.set(name, schema);
    return this;
  }
  get(name: string): z.ZodType | undefined {
    return this.schemas.get(name);
  }
  has(name: string): boolean {
    return this.schemas.has(name);
  }
  names(): string[] {
    return [...this.schemas.keys()].sort();
  }
  /** What the planner sees: names, descriptions and JSON Schemas — shapes, never content. */
  describe(): Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }> {
    return this.names().map((name) => {
      const s = this.schemas.get(name)!;
      return { name, description: s.description ?? '', jsonSchema: z.toJSONSchema(s, { target: 'draft-2020-12' }) as Record<string, unknown> };
    });
  }
}
