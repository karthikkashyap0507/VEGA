import { and, eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import type { Ambiguity, Objective, ResolvedEntity } from '@vega/contracts';
import type { LlmClient } from '@vega/llm';

/**
 * C1 — INTENT & GOAL UNDERSTANDING (docs/module4.md §5.1).
 *
 *   1. Origin first. An objective originates only from an authenticated principal or from a
 *      trigger rule the tenant wrote. Content that arrived from outside (an email body, a
 *      webhook payload) is never an objective: it is bound as an UNTRUSTED input instead.
 *   2. Entities are resolved BEFORE planning, against registries the tenant controls (its user
 *      directory, its trusted contacts). A resolved entity is TRUSTED and becomes a program
 *      input the planner may use as a recipient; an unresolved name stays out of the program.
 *   3. Ambiguity is recorded with every candidate and a best guess. Whether it BLOCKS depends on
 *      what the plan does with it (R2/R3 → never guess), so C2 decides that after planning.
 *
 * Mentions come from a model (the routine model, over the principal's own words — TRUSTED
 * input) when one is configured, else from a deterministic heuristic.
 */

export interface Mention {
  raw: string;
  kind: 'email' | 'name' | 'connector';
}

export interface MentionModel {
  mentions(text: string): Promise<{ mentions: Mention[]; constraints: string[]; successCriteria: string[] }>;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const CONNECTOR = /@(gmail|gcal|calendar|gdrive|drive|outlook|sharepoint|slack|web)\b/gi;
// Capitalized words that are instructions, days or product words, not people.
const STOP = new Set(
  'A An And The I Me My We Our Us You Your Please Let Ping Meet Notify Loop Cc Bcc Send Email E-mail Mail Draft Reply Schedule Book Set Arrange Handle Answer Post Summarize Summarise Check Write Tell Ask Remind Forward Share Create Find Show List Read Cancel Move Update Add Invite Meeting Meetings Call Sync Event Calendar Inbox Monday Tuesday Wednesday Thursday Friday Saturday Sunday Today Tomorrow Yesterday January February March April May June July August September October November December UTC AM PM FYI Re Hi Hello Thanks Also Then With To From For On At In About Regarding Notes Agenda Proposal Invoice Report'.split(' '),
);

export const heuristicMentions: MentionModel = {
  async mentions(text) {
    const out: Mention[] = [];
    const seen = new Set<string>();
    const add = (m: Mention) => {
      const k = `${m.kind}:${m.raw.toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(m);
    };
    for (const m of text.matchAll(EMAIL)) add({ raw: m[0], kind: 'email' });
    const withoutEmails = text.replace(EMAIL, ' ');
    for (const m of withoutEmails.matchAll(CONNECTOR)) add({ raw: m[1]!.toLowerCase(), kind: 'connector' });
    for (const m of withoutEmails.replace(CONNECTOR, ' ').matchAll(/\b[A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2}\b/g)) {
      const words = m[0].split(/[ -]/).filter((w) => !STOP.has(w));
      if (words.length) add({ raw: words.join(' '), kind: 'name' });
    }
    const constraints = [...text.matchAll(/\b(before|after|by|no later than|only)\b[^.,;]{2,60}/gi)].map((m) => m[0].trim());
    return { mentions: out, constraints, successCriteria: [] };
  },
};

/** The routine model extracting mentions from the principal's words (never from content). */
export function llmMentions(llm: LlmClient, model: string): MentionModel {
  return {
    async mentions(text) {
      const res = await llm.complete({
        model,
        system:
          'Extract the people, organisations and email addresses the user refers to, any constraints (deadlines, time windows), and what would count as success. Return only what is literally in the request.',
        messages: [{ role: 'user', content: text }],
        maxTokens: 800,
        outputSchema: {
          name: 'intent',
          description: 'Mentions, constraints and success criteria found in the request',
          schema: {
            type: 'object',
            properties: {
              mentions: { type: 'array', items: { type: 'object', properties: { raw: { type: 'string' }, kind: { enum: ['email', 'name', 'connector'] } }, required: ['raw', 'kind'] } },
              constraints: { type: 'array', items: { type: 'string' } },
              successCriteria: { type: 'array', items: { type: 'string' } },
            },
            required: ['mentions', 'constraints', 'successCriteria'],
          },
        },
      });
      const j = (res.json ?? {}) as { mentions?: Mention[]; constraints?: string[]; successCriteria?: string[] };
      return {
        mentions: (j.mentions ?? []).filter((m) => typeof m.raw === 'string' && m.raw.length <= 200 && ['email', 'name', 'connector'].includes(m.kind)).slice(0, 30),
        constraints: (j.constraints ?? []).filter((c) => typeof c === 'string').map((c) => c.slice(0, 300)).slice(0, 20),
        successCriteria: (j.successCriteria ?? []).filter((c) => typeof c === 'string').map((c) => c.slice(0, 300)).slice(0, 20),
      };
    },
  };
}

interface Candidate {
  id: string;
  type: 'person' | 'contact';
  name: string;
  email: string;
}

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1')
    .slice(0, 40) || 'entity';

/** Registries the tenant controls: the directory (users) and trusted contacts. */
async function candidatesFor(tenantId: string, m: Mention): Promise<Candidate[]> {
  return withTenant(tenantId, async (db) => {
    if (m.kind === 'email') {
      const email = m.raw.toLowerCase();
      const users = await db
        .select({ id: schema.users.id, name: schema.users.displayName, email: schema.users.email })
        .from(schema.users)
        .where(and(sql`lower(${schema.users.email}) = ${email}`, eq(schema.users.status, 'active')));
      const contacts = await db.select().from(schema.trustedContacts).where(eq(schema.trustedContacts.email, email));
      return [
        ...users.map((u) => ({ id: `user:${u.id}`, type: 'person' as const, name: u.name ?? u.email, email: u.email.toLowerCase() })),
        ...contacts.map((c) => ({ id: `contact:${c.id}`, type: 'contact' as const, name: c.displayName ?? c.email, email: c.email })),
      ];
    }
    const pattern = `%${m.raw.toLowerCase().replace(/[%_\\]/g, '')}%`;
    // A single word may be a first name, found in an address ("sam" → sam.lee@…); a full name is
    // matched as a name only, or "Sam Lee" would also find sam.park@….
    const single = !/\s/.test(m.raw.trim());
    const first = single ? `${m.raw.toLowerCase().replace(/[%_\\]/g, '')}%` : '';
    const users = await db
      .select({ id: schema.users.id, name: schema.users.displayName, email: schema.users.email })
      .from(schema.users)
      .where(and(eq(schema.users.status, 'active'), sql`(lower(coalesce(${schema.users.displayName}, '')) LIKE ${pattern} OR lower(split_part(${schema.users.email}, '@', 1)) LIKE ${first})`));
    const contacts = await db
      .select()
      .from(schema.trustedContacts)
      .where(sql`(lower(coalesce(${schema.trustedContacts.displayName}, '')) LIKE ${pattern} OR lower(split_part(${schema.trustedContacts.email}, '@', 1)) LIKE ${first})`);
    return [
      ...users.map((u) => ({ id: `user:${u.id}`, type: 'person' as const, name: u.name ?? u.email, email: u.email.toLowerCase() })),
      ...contacts.map((c) => ({ id: `contact:${c.id}`, type: 'contact' as const, name: c.displayName ?? c.email, email: c.email })),
    ];
  });
}

export interface UnderstandInput {
  tenantId: string;
  principalUserId: string;
  text: string;
  origin: 'principal' | 'trigger_rule';
  trigger?: string;
}

/**
 * Names people actually type are often lower-case ("email peter the notes"). Every name in the
 * tenant's own registries is a candidate mention: a whole-word, case-insensitive match of a
 * first or full name adds it. Registry names are tenant data, so this widens recall without
 * letting anything outside the registries in.
 */
async function registryMentions(tenantId: string, text: string, have: Mention[]): Promise<Mention[]> {
  const names = await withTenant(tenantId, async (db) => {
    const users = await db.select({ n: schema.users.displayName }).from(schema.users).where(eq(schema.users.status, 'active')).limit(5000);
    const contacts = await db.select({ n: schema.trustedContacts.displayName }).from(schema.trustedContacts).limit(5000);
    return [...users, ...contacts].map((r) => r.n).filter((n): n is string => Boolean(n));
  });
  const lower = text.toLowerCase();
  const covered = have.map((m) => m.raw.toLowerCase());
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const parts = name.trim().split(/\s+/);
    for (const candidate of [name.trim(), parts[0]!]) {
      const c = candidate.toLowerCase();
      if (c.length < 3 || STOP.has(candidate) || seen.has(c) || covered.some((x) => x.includes(c) || c.includes(x))) continue;
      if (new RegExp(`(^|[^a-z0-9@._-])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9@_-])`).test(lower)) {
        seen.add(c);
        // Prefer the full name when both appear ("Sam Lee" over "Sam").
        if (!out.some((m) => m.raw.toLowerCase().includes(c))) out.push({ raw: candidate, kind: 'name' });
      }
    }
  }
  return out.filter((m) => !out.some((o) => o !== m && o.raw.toLowerCase().includes(m.raw.toLowerCase())));
}

export async function understand(input: UnderstandInput, model: MentionModel): Promise<Objective> {
  const text = input.text.trim();
  if (!text) throw new Error('an objective needs text');
  const found = await model.mentions(text);
  const { constraints, successCriteria } = found;
  const mentions = [...found.mentions, ...(await registryMentions(input.tenantId, text, found.mentions))];
  const entities: ResolvedEntity[] = [];
  const ambiguities: Ambiguity[] = [];
  const used = new Set<string>(['objective', 'now', 'trigger_payload']);
  const bind = (base: string) => {
    let b = slugOf(base);
    for (let i = 2; used.has(b); i++) b = `${slugOf(base)}_${i}`;
    used.add(b);
    return b;
  };

  for (const m of mentions) {
    if (m.kind === 'connector') continue; // scopes the request (UI @-mention); not a program input
    const found = await candidatesFor(input.tenantId, m);
    const unique = [...new Map(found.map((c) => [c.email, c])).values()];
    if (m.kind === 'email' && unique.length === 0) {
      // The principal typed the address: a literal from the principal is TRUSTED (M3 §5.3).
      entities.push({ binding: bind(m.raw.split('@')[0]!), type: 'contact', raw: m.raw, resolvedId: `literal:${m.raw.toLowerCase()}`, email: m.raw.toLowerCase(), name: m.raw.toLowerCase(), confidence: 1, taint: 'TRUSTED' });
      continue;
    }
    if (unique.length === 0) continue; // an unresolved name stays out of the program
    const exact = unique.filter((c) => c.name.toLowerCase() === m.raw.toLowerCase());
    // An exact full-name match settles it; otherwise every candidate stays in play.
    const ordered = exact.length === 1 && /\s/.test(m.raw.trim()) ? exact : [...exact, ...unique.filter((c) => !exact.includes(c)).sort((a, b) => a.name.localeCompare(b.name))];
    const best = ordered[0]!;
    const binding = bind(m.raw);
    const confidence = ordered.length === 1 ? (exact.length || m.kind === 'email' ? 0.97 : 0.9) : Math.round((1 / ordered.length) * 100) / 100;
    entities.push({ binding, type: best.type, raw: m.raw, resolvedId: best.id, email: best.email, name: best.name, confidence, taint: 'TRUSTED' });
    if (ordered.length > 1) {
      ambiguities.push({
        field: `who is "${m.raw}"`,
        raw: m.raw,
        binding,
        candidates: ordered.slice(0, 20).map((c) => ({ id: c.id, label: c.name === c.email ? c.email : `${c.name} <${c.email}>`, email: c.email })),
        blocking: false,
      });
    }
  }

  return {
    objective: text,
    entities,
    constraints,
    successCriteria,
    ambiguities,
    requestedAutonomy: 'supervised',
    origin: { kind: input.origin, principalUserId: input.principalUserId, ...(input.trigger ? { trigger: input.trigger } : {}) },
  };
}

/** Applies a human's answer: the chosen candidate becomes the binding, and the ambiguity is resolved. */
export function applyClarification(o: Objective, field: string, choice: string): Objective {
  const a = o.ambiguities.find((x) => x.field === field);
  if (!a) throw new Error(`no ambiguity "${field}"`);
  const c = a.candidates.find((x) => x.id === choice);
  if (!c) throw new Error(`"${choice}" is not one of the candidates`);
  return {
    ...o,
    ambiguities: o.ambiguities.map((x) => (x === a ? { ...x, resolution: c.id, blocking: false } : x)),
    entities: o.entities.map((e) => (e.binding === a.binding ? { ...e, resolvedId: c.id, ...(c.email ? { email: c.email } : {}), name: c.label.replace(/\s*<.*>$/, ''), confidence: 1 } : e)),
  };
}
