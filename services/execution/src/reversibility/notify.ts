import type { FastRevokeCache, HoldNotifier, IncidentPager } from './engine.js';

/**
 * Delivery adapters (ntfy is the self-hosted push option, PROJECT.md §9). A held action's push
 * carries one button: Revoke, an HTTP POST with the one-tap capability in its body — never in
 * the URL, where it would land in access logs.
 */
export function ntfyNotifier(url: string, fetchImpl: typeof fetch = globalThis.fetch): HoldNotifier {
  return {
    async notify(n) {
      const res = await fetchImpl(url.replace(/\/$/, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: n.topic,
          title: n.title,
          message: n.message,
          priority: 4,
          tags: ['hourglass'],
          actions: [{ action: 'http', label: 'Revoke', url: n.revokeUrl, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: n.revokeToken }), clear: true }],
        }),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    },
  };
}

export function ntfyPager(url: string, fetchImpl: typeof fetch = globalThis.fetch): IncidentPager {
  return {
    async page(i) {
      await fetchImpl(`${url.replace(/\/$/, '')}/incidents`, {
        method: 'POST',
        headers: { title: `Incident (${i.severity})`, priority: i.severity === 'CRITICAL' ? '5' : '4', tags: 'rotating_light' },
        body: `${i.title} — tenant ${i.tenantId}${i.runId ? `, run ${i.runId}` : ''}. Open the Security Center: incident ${i.incidentId}.`,
      });
    },
  };
}

/** The Valkey half of the fast revoke path; the database stays the source of truth. */
export function valkeyCache(client: { set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown> }): FastRevokeCache {
  return { set: async (key, value, ttlMs) => void (await client.set(key, value, 'PX', Math.ceil(ttlMs))) };
}
