import type { TupleKey } from './client.js';

/**
 * Object-id helpers. OpenFGA ids are "type:id"; building them by string concatenation at
 * call sites is how a `workspace:` check ends up against a `tenant:` object.
 */
export const fga = {
  user: (id: string) => `user:${id}`,
  tenant: (id: string) => `tenant:${id}`,
  workspace: (id: string) => `workspace:${id}`,
  agent: (id: string) => `agent:${id}`,
  document: (id: string) => `document:${id}`,
  anyUser: 'user:*',
} as const;

export function tuple(user: string, relation: string, object: string): TupleKey {
  return { user, relation, object };
}
